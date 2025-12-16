(() => {
  const setFullHeight = () => {
    const fullHeightElements = document.querySelectorAll('.js-fullheight');
    fullHeightElements.forEach((el) => {
      el.style.height = `${window.innerHeight}px`;
    });
  };

  const initPasswordToggle = () => {
    document.querySelectorAll('[data-toggle="password"]').forEach((toggle) => {
      toggle.addEventListener('click', () => {
        const targetSelector = toggle.getAttribute('data-target');
        if (!targetSelector) return;
        const input = document.querySelector(targetSelector);
        if (!input) return;
        const isHidden = input.getAttribute('type') === 'password';
        input.setAttribute('type', isHidden ? 'text' : 'password');
        const icon = toggle.querySelector('i');
        if (icon) {
          icon.classList.toggle('fa-eye');
          icon.classList.toggle('fa-eye-slash');
        }
      });
    });
  };

  const updateStatus = (message, variant = 'success') => {
    const status = document.getElementById('login-status');
    if (!status) return;
    status.textContent = message;
    status.className = `status is-visible status--${variant}`;
  };

  const handleLogin = () => {
    const form = document.getElementById('login-form');
    const usernameInput = document.getElementById('username');
    const passwordInput = document.getElementById('password');
    const rememberInput = document.getElementById('remember');

    if (!form || !usernameInput || !passwordInput) return;

    // Pré-remplit depuis le stockage local pour fluidifier les tests en local.
    const storedUser = localStorage.getItem('trendScopeUser');
    const storedPass = localStorage.getItem('trendScopePass');
    if (storedUser) usernameInput.value = storedUser;
    if (storedPass) passwordInput.value = storedPass;

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const username = usernameInput.value.trim();
      const password = passwordInput.value.trim();
      const remember = rememberInput?.checked;

      if (!username || !password) {
        updateStatus('Merci de renseigner un identifiant et un mot de passe.', 'error');
        return;
      }

      if (remember) {
        localStorage.setItem('trendScopeUser', username);
        localStorage.setItem('trendScopePass', password);
      } else {
        localStorage.removeItem('trendScopeUser');
        localStorage.removeItem('trendScopePass');
      }

      updateStatus(
        'Connexion prête. Les identifiants seront validés côté serveur Supabase avant ouverture du tableau de bord.',
        'success'
      );
    });
  };

  document.addEventListener('DOMContentLoaded', () => {
    setFullHeight();
    window.addEventListener('resize', setFullHeight);
    initPasswordToggle();
    handleLogin();
  });
})();
