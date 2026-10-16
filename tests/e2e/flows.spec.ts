// E2E：通常１周、差し戻し１周、同時更新（409）、通信失敗、未保存確認、表示幅。
import { expect, test, type Page } from '@playwright/test';

async function loginAs(page: Page, name: RegExp) {
  await page.goto('/');
  await page.getByRole('button', { name }).click();
  await expect(page.getByRole('heading', { name: '今日の返却' })).toBeVisible();
}

async function switchUser(page: Page, label: string) {
  await page.getByText('デモ操作（役割切替・通信失敗）').click();
  await page.getByLabel('担当者を切り替える（役割）').selectOption({ label });
  await expect(page.getByRole('heading', { name: '今日の返却' })).toBeVisible();
  await page.getByText('デモ操作（役割切替・通信失敗）').click();
}

/** 再読込するとデモデータが初期化されるため、アプリ内で遷移する。 */
async function go(page: Page, path: string) {
  await page.evaluate((p) => {
    history.pushState(null, '', p);
    dispatchEvent(new Event('rd:navigate'));
  }, path);
}

async function openRental(page: Page, no: string) {
  await page.getByRole('button', { name: '返却を確認' }).click();
  await page.getByLabel('貸出番号（または顧客名）').fill(no);
  await page.getByRole('list', { name: '検索結果' }).getByRole('button', { name: new RegExp(no) }).click();
  await expect(page.getByRole('heading', { name: '返却を確認' })).toBeVisible();
}

test('通常１周：返却8・破損1（写真）→承認3,000円→CSV出力だけでは未受領→外部番号で受領', async ({ page }) => {
  await loginAs(page, /返却担当A/);
  await openRental(page, 'R-001');
  const chair = page.getByRole('region', { name: '折りたたみ椅子' });
  await chair.getByLabel('今回返却数（脚）').fill('11');
  await expect(chair.getByText('未返却は残り10脚までです')).toBeVisible();
  await chair.getByLabel('今回返却数（脚）').fill('8');
  await page.getByRole('region', { name: '長机（1800）' }).getByRole('button', { name: '全数（5）' }).click();
  await page.getByRole('button', { name: '次へ（状態・写真）' }).click();

  const s = page.getByRole('region', { name: '折りたたみ椅子' });
  await s.getByLabel('うち破損数（脚）').fill('1');
  await expect(s.getByText('2脚が未返却（保存後も未返却として残ります）')).toBeVisible();
  await s.getByRole('button', { name: '架空写真Aを追加' }).click();
  await expect(s.getByText('未送信')).toBeVisible();
  await page.getByRole('button', { name: '次へ（提出内容の確認）' }).click();
  await expect(page.getByText('折りたたみ椅子：2脚が未返却です')).toBeVisible();
  await page.getByRole('button', { name: '確認して保存' }).click();
  await expect(page.getByText('保存しました')).toBeVisible();
  await expect(page.getByText('写真 1枚 送信済み')).toBeVisible();

  // 破損の確認依頼
  await page.getByRole('button', { name: '不足・破損を確認' }).click();
  await page.getByRole('button', { name: /破損.*R-001/ }).first().click();
  await page.getByRole('button', { name: '確認を依頼' }).click();
  await expect(page.locator('.pane-work .status', { hasText: '確認待ち' }).first()).toBeVisible();

  // 責任者が承認
  await switchUser(page, 'テスト事務／検品責任者・事務');
  await page.getByRole('button', { name: /責任者確認/ }).click();
  await page.getByRole('button', { name: /破損.*R-001/ }).click();
  await page.getByRole('button', { name: '責任者確認へ' }).click();
  await page.getByRole('radio', { name: '修理' }).check();
  await page.getByRole('radio', { name: '請求候補' }).check();
  await page.getByLabel('請求候補の金額（円・税抜）').fill('3000');
  await page.getByLabel('判断理由').fill('脚の変形');
  await page.getByRole('button', { name: '承認して事務へ' }).click();
  const dlg = page.getByRole('dialog', { name: 'この内容で承認しますか' });
  await expect(dlg.getByText('3,000円')).toBeVisible();
  await dlg.getByRole('button', { name: '承認する' }).click();
  await expect(page.locator('.pane-work .status', { hasText: '承認済み・事務未受領' }).first()).toBeVisible();

  // 事務：CSV出力だけでは未受領のまま
  await go(page, '/handoff');
  await expect(page.getByRole('heading', { name: '事務引き渡し' })).toBeVisible();
  const card = page.locator('.card', { hasText: 'R-001' }).filter({ hasText: '未受領' });
  await card.getByLabel('CSV出力の対象にする').check();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /請求候補CSVを出力/ }).click();
  const csv = await (await download).path();
  const fs = await import('node:fs');
  const text = fs.readFileSync(csv!, 'utf8');
  expect(text).toContain('R-001,1,');
  expect(text).toContain(',3000,JPY,脚の変形');
  await expect(card.getByText('未受領')).toBeVisible();
  await expect(card.getByText(/CSV出力済み/)).toBeVisible();
  await card.getByLabel(/外部処理番号/).fill('INV-0001');
  await card.getByRole('button', { name: '既存ソフトへの反映を確認して受領' }).click();
  await expect(page.getByText(/R-001 折りたたみ椅子 を受領しました/)).toBeVisible();
});

test('差し戻し１周：写真不足で差し戻された破損に写真を追加して再依頼', async ({ page }) => {
  await loginAs(page, /返却担当A/);
  await page.getByRole('button', { name: '差し戻しを直す' }).click();
  await page.getByRole('button', { name: /R-008/ }).click();
  await expect(page.getByRole('alert').getByText(/破損箇所が写っていません/)).toBeVisible();
  await page.getByRole('button', { name: '架空写真Bを追加' }).click();
  await page.getByRole('button', { name: '写真を送信' }).click();
  await expect(page.getByText('写真 1枚 送信しました')).toBeVisible();
  await page.getByRole('button', { name: '直して確認を依頼' }).click();
  await expect(page.locator('.pane-work .status', { hasText: '確認待ち' }).first()).toBeVisible();
});

test('同時更新：別端末が先に保存すると409で比較表示し、自動上書きしない', async ({ page }) => {
  await loginAs(page, /返却担当A/);
  await openRental(page, 'R-002');
  await page.getByRole('region', { name: 'テント（3×3）' }).getByRole('button', { name: '全数（2）' }).click();
  await page.getByRole('button', { name: '次へ（状態・写真）' }).click();
  await page.getByRole('button', { name: '次へ（提出内容の確認）' }).click();
  await page.getByText('デモ操作（役割切替・通信失敗）').click();
  await page.getByRole('button', { name: '別端末から先に1つ返却する（409を発生）' }).click();
  await page.getByRole('button', { name: '確認して保存' }).click();
  await expect(page.getByText('他の担当者が先にこの貸出を更新しました')).toBeVisible();
  await expect(page.getByText('最新の未返却を超えています')).toBeVisible();
  await expect(page.getByText('保存しました')).toHaveCount(0);
  await page.getByRole('button', { name: '最新値で入力を見直す' }).click();
  await expect(page.getByText('未返却は残り1張までです')).toBeVisible();
});

test('通信：タイムアウト後は成否照会で確定済みを確認、未到達は保存済みにしない', async ({ page }) => {
  await loginAs(page, /返却担当A/);
  await openRental(page, 'R-003');
  await page.getByRole('region', { name: '演台' }).getByRole('button', { name: '全数（1）' }).click();
  await page.getByRole('button', { name: '次へ（状態・写真）' }).click();
  await page.getByRole('button', { name: '次へ（提出内容の確認）' }).click();
  await page.getByText('デモ操作（役割切替・通信失敗）').click();
  await page.getByLabel('通信失敗（サーバー未到達）').check();
  await page.getByRole('button', { name: '確認して保存' }).click();
  await expect(page.getByText('保存されていません')).toBeVisible();
  await expect(page.getByText('保存しました')).toHaveCount(0);
  await page.getByLabel('タイムアウト（サーバーは確定・応答なし）').check();
  await page.getByRole('button', { name: '同じ内容でもう一度保存' }).click();
  await expect(page.getByText('保存しました')).toBeVisible();
  // 二重に保存されていない
  await page.getByRole('button', { name: 'この貸出の履歴' }).click();
  await expect(page.locator('.timeline li', { hasText: '返却を記録' })).toHaveCount(1);
});

test('未保存の入力がある時は戻る前に確認する', async ({ page }) => {
  await loginAs(page, /返却担当A/);
  await openRental(page, 'R-001');
  await page.getByRole('region', { name: '折りたたみ椅子' }).getByLabel('今回返却数（脚）').fill('3');
  await page.getByRole('button', { name: '貸出を選び直す' }).click();
  const dlg = page.getByRole('dialog', { name: '保存していない入力があります' });
  await dlg.getByRole('button', { name: '編集を続ける' }).click();
  await expect(page.getByRole('region', { name: '折りたたみ椅子' }).getByLabel('今回返却数（脚）')).toHaveValue('3');
  await page.getByRole('button', { name: '貸出を選び直す' }).click();
  await dlg.getByRole('button', { name: '入力を破棄' }).click();
  await expect(page.getByRole('heading', { name: '返却する貸出を選ぶ' })).toBeVisible();
});

for (const width of [360, 390, 430, 768, 1280]) {
  test(`表示幅 ${width}px・文字200%で本文の横スクロールなし`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await loginAs(page, /返却担当A/);
    await page.addStyleTag({ content: 'body{font-size:32px !important} h1{font-size:44px !important}' });
    for (const path of ['/', '/issues?tab=open', '/rentals/x']) {
      if (path === '/rentals/x') {
        await go(page, '/');
        await openRental(page, 'R-001');
      } else await go(page, path);
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, path).toBeLessThanOrEqual(1);
    }
  });
}
