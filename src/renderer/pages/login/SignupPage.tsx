import loginLogo from '@renderer/assets/logos/brand/app.png';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { changeLanguage } from '@/renderer/services/i18n';
import AppLoader from '@renderer/components/layout/AppLoader';
import { useAuth } from '../../hooks/context/AuthContext';
import './LoginPage.css';

type MessageState = {
  type: 'error' | 'success';
  text: string;
};

const SignupPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { status, register } = useAuth();

  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [message, setMessage] = useState<MessageState | null>(null);
  const [loading, setLoading] = useState(false);

  const usernameRef = useRef<HTMLInputElement | null>(null);
  const messageTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    document.body.classList.add('login-page-active');
    return () => {
      document.body.classList.remove('login-page-active');
      if (messageTimer.current) {
        window.clearTimeout(messageTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    document.title = t('login.signup.pageTitle');
  }, [t]);

  useEffect(() => {
    document.documentElement.lang = i18n.language;
  }, [i18n.language]);

  useEffect(() => {
    window.setTimeout(() => usernameRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (status === 'authenticated') {
      void navigate('/guid', { replace: true });
    }
  }, [navigate, status]);

  const clearMessageLater = useCallback(() => {
    if (messageTimer.current) {
      window.clearTimeout(messageTimer.current);
    }
    messageTimer.current = window.setTimeout(() => {
      setMessage((prev) => (prev?.type === 'success' ? prev : null));
    }, 5000);
  }, []);

  const showMessage = useCallback(
    (next: MessageState) => {
      setMessage(next);
      if (next.type === 'error') {
        clearMessageLater();
      }
    },
    [clearMessageLater]
  );

  const supportedLanguages = useMemo<{ code: string; label: string }[]>(
    () => [
      { code: 'zh-CN', label: '简体中文' },
      { code: 'zh-TW', label: '繁體中文' },
      { code: 'ja-JP', label: '日本語' },
      { code: 'ko-KR', label: '한국어' },
      { code: 'tr-TR', label: 'Türkçe' },
      { code: 'uk-UA', label: 'Українська' },
      { code: 'en-US', label: 'English' },
    ],
    []
  );

  const handleLanguageChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
    const nextLanguage = event.target.value;
    changeLanguage(nextLanguage).catch((error: Error) => {
      console.error('Failed to change language:', error);
    });
  }, []);

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const trimmedUsername = username.trim();
      const trimmedEmail = email.trim();

      if (!trimmedUsername || !password) {
        showMessage({ type: 'error', text: t('login.signup.errors.empty') });
        return;
      }
      if (password !== passwordConfirm) {
        showMessage({ type: 'error', text: t('login.signup.errors.passwordMismatch') });
        return;
      }

      setLoading(true);
      setMessage(null);

      const result = await register({
        username: trimmedUsername,
        email: trimmedEmail || undefined,
        password,
      });

      if (result.success) {
        showMessage({ type: 'success', text: t('login.signup.success') });
        window.setTimeout(() => {
          void navigate('/guid', { replace: true });
        }, 600);
      } else {
        const errorText = (() => {
          switch (result.code) {
            case 'signupDisabled':
              return t('login.signup.errors.disabled');
            case 'invalidInput':
              return t('login.signup.errors.invalidInput');
            case 'weakPassword':
              return result.details?.length
                ? `${t('login.signup.errors.weakPassword')} (${result.details.join('; ')})`
                : t('login.signup.errors.weakPassword');
            case 'usernameTaken':
              return t('login.signup.errors.usernameTaken');
            case 'tooManyAttempts':
              return t('login.signup.errors.tooManyAttempts');
            case 'networkError':
              return t('login.signup.errors.networkError');
            case 'serverError':
              return t('login.signup.errors.serverError');
            case 'unknown':
            default:
              return result.message ?? t('login.signup.errors.unknown');
          }
        })();

        showMessage({ type: 'error', text: errorText });
      }

      setLoading(false);
    },
    [email, navigate, password, passwordConfirm, register, showMessage, t, username]
  );

  if (status === 'checking') {
    return <AppLoader />;
  }

  return (
    <div className='login-page'>
      <div className='login-page__card'>
        <label className='login-page__lang-select-wrapper' htmlFor='lang-select'>
          <select
            id='lang-select'
            className='login-page__lang-select'
            value={i18n.language}
            onChange={handleLanguageChange}
          >
            {supportedLanguages.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.label}
              </option>
            ))}
          </select>
        </label>

        <div className='login-page__header'>
          <div className='login-page__logo'>
            <img src={loginLogo} alt={t('login.brand')} />
          </div>
          <h1 className='login-page__title'>{t('login.signup.title')}</h1>
          <p className='login-page__subtitle'>{t('login.signup.subtitle')}</p>
        </div>

        <form className='login-page__form' onSubmit={handleSubmit}>
          <div className='login-page__form-item'>
            <label className='login-page__label' htmlFor='signup-username'>
              {t('login.username')}
            </label>
            <div className='login-page__input-wrapper'>
              <input
                ref={usernameRef}
                id='signup-username'
                name='username'
                className='login-page__input'
                placeholder={t('login.usernamePlaceholder')}
                autoComplete='username'
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                aria-required='true'
                minLength={3}
                maxLength={64}
              />
            </div>
          </div>

          <div className='login-page__form-item'>
            <label className='login-page__label' htmlFor='signup-email'>
              {t('login.signup.email')}
            </label>
            <div className='login-page__input-wrapper'>
              <input
                id='signup-email'
                name='email'
                type='email'
                className='login-page__input'
                placeholder={t('login.signup.emailPlaceholder')}
                autoComplete='email'
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
          </div>

          <div className='login-page__form-item'>
            <label className='login-page__label' htmlFor='signup-password'>
              {t('login.password')}
            </label>
            <div className='login-page__input-wrapper'>
              <input
                id='signup-password'
                name='password'
                type={passwordVisible ? 'text' : 'password'}
                className='login-page__input'
                placeholder={t('login.passwordPlaceholder')}
                autoComplete='new-password'
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-required='true'
              />
              <button
                type='button'
                className='login-page__toggle-password'
                onClick={() => setPasswordVisible((prev) => !prev)}
                aria-label={passwordVisible ? t('login.hidePassword') : t('login.showPassword')}
              >
                <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2'>
                  {passwordVisible ? (
                    <>
                      <path d='M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24' />
                      <line x1='1' y1='1' x2='23' y2='23' />
                    </>
                  ) : (
                    <>
                      <path d='M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z' />
                      <circle cx='12' cy='12' r='3' />
                    </>
                  )}
                </svg>
              </button>
            </div>
          </div>

          <div className='login-page__form-item'>
            <label className='login-page__label' htmlFor='signup-password-confirm'>
              {t('login.signup.passwordConfirm')}
            </label>
            <div className='login-page__input-wrapper'>
              <input
                id='signup-password-confirm'
                name='passwordConfirm'
                type={passwordVisible ? 'text' : 'password'}
                className='login-page__input'
                placeholder={t('login.signup.passwordConfirmPlaceholder')}
                autoComplete='new-password'
                value={passwordConfirm}
                onChange={(event) => setPasswordConfirm(event.target.value)}
                aria-required='true'
              />
            </div>
          </div>

          <button type='submit' className='login-page__submit' disabled={loading}>
            {loading && (
              <svg className='login-page__spinner' viewBox='0 0 24 24' width='18' height='18'>
                <circle
                  cx='12'
                  cy='12'
                  r='10'
                  stroke='currentColor'
                  strokeWidth='3'
                  fill='none'
                  strokeDasharray='50'
                  strokeDashoffset='25'
                  strokeLinecap='round'
                />
              </svg>
            )}
            <span>{loading ? t('login.signup.submitting') : t('login.signup.submit')}</span>
          </button>

          <div
            role='alert'
            aria-live='polite'
            className={`login-page__message ${message ? 'login-page__message--visible' : ''} ${message ? (message.type === 'success' ? 'login-page__message--success' : 'login-page__message--error') : ''}`}
            hidden={!message}
          >
            {message?.text}
          </div>
        </form>

        <div className='login-page__footer'>
          <div className='login-page__footer-content'>
            <span>{t('login.signup.haveAccount')}</span>
            <Link to='/login' className='login-page__footer-link'>
              {t('login.signup.signInLink')}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SignupPage;
