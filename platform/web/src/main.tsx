import { createRoot } from 'react-dom/client';
import './style.css';

const root = document.getElementById('root');
if (root === null) throw new Error('Missing platform UI root');
createRoot(root).render(
  <main className="login">
    <h1>登录 DSH 团队平台</h1>
    <p id="login-status">登录功能尚未开放。</p>
    <form aria-label="登录" aria-describedby="login-status">
      <fieldset disabled>
        <legend>账号登录</legend>
        <label htmlFor="email">邮箱</label>
        <input id="email" type="email" autoComplete="username" />
        <label htmlFor="password">密码</label>
        <input id="password" type="password" autoComplete="current-password" />
        <button type="button" disabled>
          登录
        </button>
      </fieldset>
    </form>
  </main>,
);
