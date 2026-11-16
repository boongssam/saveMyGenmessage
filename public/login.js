(async () => {
  const $ = (id) => document.getElementById(id);
  const state = await fetch('/api/auth-state').then((r) => r.json());
  if (state.authed) return location.replace('/');

  const setup = state.needsSetup;
  if (setup) {
    $('sub').textContent = '처음 사용하시네요. 보관함을 열 때 쓸 비밀번호를 정해 주세요.';
    $('pwLabel').textContent = '새 비밀번호 (4자 이상)';
    $('confirmRow').hidden = false;
    $('pw2').required = true;
    $('submit').textContent = '비밀번호 정하고 시작하기';
  }

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('err').textContent = '';
    const password = $('pw').value;
    if (setup && password !== $('pw2').value) {
      $('err').textContent = '두 비밀번호가 서로 다릅니다.';
      return;
    }
    $('submit').disabled = true;
    try {
      const res = await fetch(setup ? '/api/setup' : '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || '로그인하지 못했습니다.');
      location.replace('/');
    } catch (err) {
      $('err').textContent = err.message;
      $('pw').select();
    } finally {
      $('submit').disabled = false;
    }
  });
})();
