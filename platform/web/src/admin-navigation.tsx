export function AdminNavigation({ page }: { page: 'accounts' | 'audit' }) {
  return (
    <nav aria-label="后台导航">
      <a href="/_platform/admin" aria-current={page === 'accounts' ? 'page' : undefined}>
        账号管理
      </a>
      <a href="/_platform/admin/audit" aria-current={page === 'audit' ? 'page' : undefined}>
        审计日志
      </a>
      <a href="/_platform/account">账号设置</a>
      <a href="/">返回工作台</a>
    </nav>
  );
}
