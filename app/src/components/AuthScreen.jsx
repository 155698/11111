import { useEffect, useState } from 'react';

export default function AuthScreen({ socket, onAuth }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState(() => localStorage.getItem('mvt_username') || '');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState(() => localStorage.getItem('mvt_password') || '');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [remember, setRemember] = useState(true);

  useEffect(() => {
    const offErr = socket.on('auth:error', (d) => { setError(d.error); setLoading(false); });
    const offOk = socket.on('auth:ok', (d) => { onAuth(d.user); });
    return () => { offErr(); offOk(); };
  }, [socket, onAuth]);

  function submit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    if (mode === 'login') {
      socket.login(username, password, remember);
    } else {
      socket.register(username, displayName, password, remember);
    }
    // when "remember me" is checked, keep login+password for prefill;
    // when unchecked, clear them
    if (remember) {
      localStorage.setItem('mvt_username', username.trim());
      localStorage.setItem('mvt_password', password);
    } else {
      localStorage.removeItem('mvt_username');
      localStorage.removeItem('mvt_password');
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1 style={{ fontWeight: 700, marginBottom: 4 }}>MultiVoice</h1>
        <p className="auth-sub">{mode === 'login' ? 'С возвращением!' : 'Создай аккаунт'}</p>
        <form onSubmit={submit} className="auth-form">
          <label>Имя пользователя</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="например: ann" required />
          {mode === 'register' && (
            <>
              <label>Отображаемое имя</label>
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Аня" />
            </>
          )}
          <label>Пароль</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
          {error && <p className="auth-error">{error}</p>}
          <label className="remember-row">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span>Запомнить меня</span>
          </label>
          <button className="btn-primary" type="submit" disabled={loading}>
            {loading ? 'Подождите…' : mode === 'login' ? 'Войти' : 'Зарегистрироваться'}
          </button>
        </form>
        <p className="auth-switch">
          {mode === 'login' ? (
            <>Нет аккаунта? <a onClick={() => { setMode('register'); setError(''); }}>Зарегистрироваться</a></>
          ) : (
            <>Уже есть аккаунт? <a onClick={() => { setMode('login'); setError(''); }}>Войти</a></>
          )}
        </p>
      </div>
    </div>
  );
}