import { DemoRepository } from '../../src/data/demo/demoRepository';
import { DemoServer, emptyDb } from '../../src/data/demo/demoServer';
import { createSeededServer, DEMO_ORG_ID, SITE_ID, USERS, SOURCE_SYSTEM } from '../../src/data/demo/seed';
import { searchKey } from '../../src/domain/searchKey';
import { uuid } from '../../src/domain/ids';

export { USERS, DEMO_ORG_ID };

/** 遅延なしのリポジトリ（シード済み）。 */
export async function repoAs(userId: string, server?: DemoServer) {
  const repo = new DemoRepository({ server: server ?? createSeededServer(), latencyMs: 0 });
  await repo.login(userId, false);
  return repo;
}

/** 貸出10脚だけを持つ最小のサーバー（AC01～05用）。 */
export function serverWithChairs10(): { server: DemoServer; rentalId: string; lineId: string } {
  const seeded = createSeededServer();
  const db = emptyDb();
  db.orgs = seeded.db.orgs;
  db.members = seeded.db.members;
  db.sites = seeded.db.sites;
  db.settings = seeded.db.settings;
  const rentalId = uuid();
  const lineId = uuid();
  db.rentals.push({
    id: rentalId,
    orgId: DEMO_ORG_ID,
    siteId: SITE_ID,
    sourceSystem: SOURCE_SYSTEM,
    externalRentalIdOriginal: 'AC-001',
    externalRentalIdSearch: searchKey('AC-001'),
    customerLabelOriginal: '受入試験（架空）',
    customerLabelSearch: searchKey('受入試験（架空）'),
    dueAt: new Date().toISOString(),
    status: 'open',
    version: 1,
    externalReturnAckAt: null,
    externalReturnRef: null,
    externalReturnNoRefReason: null,
    createdAt: new Date().toISOString(),
  });
  db.rentalLines.push({
    id: lineId,
    orgId: DEMO_ORG_ID,
    rentalId,
    externalLineIdOriginal: '1',
    itemCodeOriginal: 'CH-01',
    itemNameOriginal: '折りたたみ椅子',
    unitOriginal: '脚',
    qtyOut: 10,
    version: 1,
  });
  return { server: new DemoServer(db), rentalId, lineId };
}

/** テスト用の最小JPEG（SOF0に寸法を持つヘッダのみ）。 */
export function tinyJpeg(width = 8, height = 8): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11,
    0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
  ]);
}
