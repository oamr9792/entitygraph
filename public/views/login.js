import { h, api, toast, state } from '../app.js';
import { DISCLAIMERS } from '../lib/metrics-ui.js';

/**
 * The login screen, and the forced password change that follows a first sign-in.
 *
 * Rendered outside the normal shell: someone who is not signed in should not
 * see the navigation for screens they cannot open.
 */
export function loginView({ onSignedIn }) {
  const email = h('input', { type: 'email', name: 'email', autocomplete: 'username', required: 'required', placeholder: 'you@firm.com' });
  const password = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: 'required' });
  const error = h('div', { class: 'form-error', style: { display: 'none' } });
  const button = h('button', { class: 'primary', type: 'submit' }, 'Sign in');

  const form = h('form', { class: 'auth-form' },
    h('label', { class: 'field' }, 'Email', email),
    h('label', { class: 'field' }, 'Password', password),
    error,
    button
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.style.display = 'none';
    button.disabled = true;
    button.textContent = 'Signing in…';
    try {
      const { user } = await api('/api/auth/login', {
        method: 'POST',
        body: { email: email.value.trim(), password: password.value },
      });
      state.user = user;
      onSignedIn(user);
    } catch (err) {
      error.textContent = err.message;
      error.style.display = '';
      password.value = '';
      password.focus();
    } finally {
      button.disabled = false;
      button.textContent = 'Sign in';
    }
  });

  setTimeout(() => email.focus(), 0);

  return h('div', { class: 'auth-screen' },
    h('div', { class: 'auth-card' },
      h('div', { class: 'brand' }, '◕', h('div', {}, 'EntityGraph', h('small', {}, 'Association Intelligence'))),
      h('p', { class: 'small muted' }, 'Sign in to continue.'),
      form
    ),
    h('p', { class: 'auth-footnote' }, DISCLAIMERS.external_estimate)
  );
}

/**
 * Shown when `must_change_password` is set — after a bootstrap or an admin
 * reset. There is no way past it: the generated password was printed to a
 * console log or handed over in a message, and neither is a place a working
 * credential should stay.
 */
export function changePasswordView({ onDone }) {
  const next = h('input', { type: 'password', name: 'new_password', autocomplete: 'new-password', required: 'required' });
  const confirm = h('input', { type: 'password', name: 'confirm', autocomplete: 'new-password', required: 'required' });
  const error = h('div', { class: 'form-error', style: { display: 'none' } });
  const button = h('button', { class: 'primary', type: 'submit' }, 'Set password');

  const form = h('form', { class: 'auth-form' },
    h('label', { class: 'field' }, 'New password',
      next,
      h('span', { class: 'hint' }, 'At least 12 characters. Length matters more than punctuation.')),
    h('label', { class: 'field' }, 'Confirm', confirm),
    error,
    button
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.style.display = 'none';
    if (next.value !== confirm.value) {
      error.textContent = 'The two passwords do not match.';
      error.style.display = '';
      return;
    }
    button.disabled = true;
    try {
      await api('/api/auth/password', { method: 'POST', body: { new_password: next.value } });
      toast('Password set', 'success');
      onDone();
    } catch (err) {
      error.textContent = err.message;
      error.style.display = '';
    } finally {
      button.disabled = false;
    }
  });

  setTimeout(() => next.focus(), 0);

  return h('div', { class: 'auth-screen' },
    h('div', { class: 'auth-card' },
      h('h1', {}, 'Choose a password'),
      h('p', { class: 'small muted' },
        'Your account was created with a temporary password. Set your own before continuing.'),
      form
    )
  );
}
