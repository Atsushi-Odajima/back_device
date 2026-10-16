import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { useApp } from './app/AppContext';
import { match, useRouter } from './app/router';
import { Button, Modal } from './components/ui';
import { MarkIcon } from './components/Icons';
import { ROLE_LABEL } from './components/labels';
import { APP_MODE } from './components/photos';
import { LoginScreen } from './screens/LoginScreen';
import { HomeScreen } from './screens/HomeScreen';
import { SearchScreen } from './screens/SearchScreen';
import { ReturnFlowScreen } from './screens/ReturnFlow';
import { IssuesScreen } from './screens/IssuesScreen';
import { ReviewScreen } from './screens/ReviewScreen';
import { HandoffScreen } from './screens/HandoffScreen';
import { ImportScreen } from './screens/ImportScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { RentalScreen } from './screens/RentalScreen';

// デモ専用の部品。VITE_APP_MODE は静的に置換されるため pilot ビルドでは読み込まれない。
const DemoBanner = APP_MODE === 'demo' ? lazy(() => import('./data/demo/DemoPanel').then((m) => ({ default: m.DemoBanner }))) : null;
const DemoPanel = APP_MODE === 'demo' ? lazy(() => import('./data/demo/DemoPanel').then((m) => ({ default: m.DemoPanel }))) : null;

function Routes(): ReactNode {
  const { path } = useRouter();
  let m: Record<string, string> | null;
  if (path === '/' || path === '') return <HomeScreen />;
  if (path === '/rentals') return <SearchScreen />;
  if ((m = match('/rentals/:id/return', path))) return <ReturnFlowScreen key={m.id} rentalId={m.id!} />;
  if ((m = match('/rentals/:id', path))) return <RentalScreen key={m.id} rentalId={m.id!} />;
  if (path === '/issues') return <IssuesScreen selectedId={null} />;
  if ((m = match('/issues/:id/review', path))) return <ReviewScreen key={m.id} issueId={m.id!} />;
  if ((m = match('/issues/:id', path))) return <IssuesScreen selectedId={m.id!} />;
  if (path === '/handoff') return <HandoffScreen />;
  if (path === '/import') return <ImportScreen />;
  if (path === '/settings') return <SettingsScreen />;
  return (
    <div className="stack">
      <h1>ページが見つかりません</h1>
      <a href="/">今日の返却へ</a>
    </div>
  );
}

function Header() {
  const { session, repo, refreshSession, bumpData } = useApp();
  const { navigate } = useRouter();
  const reviewer = session && session.role !== 'operator';
  const go = (to: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    (e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
    navigate(to);
  };
  return (
    <header className="app-header">
      <div className="app-header-inner">
        <a className="brand" href="/" onClick={go('/')}>
          <MarkIcon />
          <span>
            返却デスク<small>（仮称）</small>
          </span>
        </a>
        <span className="header-spacer" />
        {session && (
          <>
            <span className="header-user" title={`${session.displayName}／${ROLE_LABEL[session.role]}`}>
              <span>{session.displayName}</span>
              <span>{ROLE_LABEL[session.role]}</span>
            </span>
            <details style={{ position: 'relative' }}>
              <summary className="btn" aria-label="メニュー" style={{ listStyle: 'none' }}>
                メニュー
              </summary>
              <nav className="card stack-sm" style={{ position: 'absolute', right: 0, top: 52, zIndex: 40, minWidth: 220, boxShadow: 'var(--shadow-modal)' }}>
                <a className="btn" href="/" onClick={go('/')}>今日の返却</a>
                <a className="btn" href="/rentals?mode=open" onClick={go('/rentals?mode=open')}>貸出を探す</a>
                <a className="btn" href="/issues?tab=open" onClick={go('/issues?tab=open')}>不足・破損</a>
                {reviewer && <a className="btn" href="/handoff" onClick={go('/handoff')}>事務引き渡し</a>}
                {reviewer && <a className="btn" href="/import" onClick={go('/import')}>CSV取込</a>}
                <a className="btn" href="/settings" onClick={go('/settings')}>設定</a>
                <button
                  type="button"
                  className="btn"
                  onClick={async (e) => {
                    (e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
                    await repo.logout();
                    refreshSession();
                    bumpData(); // 業務キャッシュを破棄（オブジェクトURLは各画面のアンマウントで破棄）
                    navigate('/', { force: true });
                  }}
                >
                  ログアウト
                </button>
              </nav>
            </details>
          </>
        )}
      </div>
    </header>
  );
}

export function App() {
  const { session, reauthNeeded, completeReauth } = useApp();
  const { pendingNav, confirmLeave, cancelLeave } = useRouter();

  useEffect(() => {
    document.title = APP_MODE === 'demo' ? '返却デスク（仮称）検証用デモ' : '返却デスク（仮称）';
  }, []);

  return (
    <>
      {DemoBanner && (
        <Suspense fallback={<div className="demo-banner">検証用デモ・サンプルデータ</div>}>
          <DemoBanner />
        </Suspense>
      )}
      {DemoPanel && session && (
        <Suspense fallback={null}>
          <DemoPanel />
        </Suspense>
      )}
      <Header />
      <main>{session ? <Routes /> : <LoginScreen />}</main>
      {pendingNav && (
        <Modal title="保存していない入力があります" onClose={cancelLeave}>
          <p>この画面を離れると、まだ保存していない入力は失われます。</p>
          <div className="row">
            <Button variant="primary" onClick={cancelLeave}>
              編集を続ける
            </Button>
            <Button onClick={confirmLeave}>入力を破棄</Button>
          </div>
        </Modal>
      )}
      {reauthNeeded && session && (
        <Modal title="再ログイン">
          <LoginScreen reauth onDone={completeReauth} />
        </Modal>
      )}
    </>
  );
}
