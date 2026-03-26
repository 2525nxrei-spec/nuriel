/**
 * ヌリエル メインアプリケーション JavaScript
 * - API通信モジュール（fetch wrapper）
 * - 認証（ログイン/登録/ログアウト/セッション確認）
 * - 画面ルーティング（hash-based）
 * - 写真アップロード（ファイル選択+ドラッグ&ドロップ+カメラ）
 * - 画像変換リクエスト + ポーリング
 * - ギャラリー表示・削除
 * - プラン管理
 */

'use strict';

/* ==============================================
   設定値（API エンドポイント等はここで管理）
   ============================================== */
const CONFIG = {
  API_BASE: '/api',
  STRIPE_CHECKOUT_URL: '/api/billing/checkout',
  /* 要設定: Stripe公開鍵（本番時に pk_live_xxxx を設定。未設定でも決済以外は動作する） */
  /* Stripeダッシュボード > Developers > API Keys > Publishable key からコピー */
  STRIPE_PUBLISHABLE_KEY: '',
  // ポーリング間隔（ミリ秒）
  POLL_INTERVAL: 2000,
  // ポーリング最大回数
  POLL_MAX_RETRIES: 60,
  // 対応画像形式
  ACCEPTED_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
  // 最大ファイルサイズ（10MB）
  MAX_FILE_SIZE: 10 * 1024 * 1024,
  // エラーメッセージ（親切な日本語）
  ERRORS: {
    INVALID_FORMAT: '画像形式を確認してください（JPEG, PNG, WebP, HEIC に対応しています）',
    FILE_TOO_LARGE: '画像は10MB以内にしてください',
    CONVERT_FAIL: '変換に失敗しました。別の画像でお試しください',
    NETWORK_ERROR: 'ネット接続を確認してください',
    CONVERT_TIMEOUT: '変換がタイムアウトしました。時間をおいて再度お試しください',
    NO_IMAGE: '写真を選んでください',
    QUOTA_EXCEEDED: '今月の変換枚数を使い切りました。プランのアップグレードをご検討ください',
    UPLOAD_FAIL: '画像のアップロードに失敗しました。もう一度お試しください',
    PDF_FAIL: 'PDFの取得に失敗しました。もう一度お試しください',
  },
};

/* ==============================================
   API 通信モジュール
   ============================================== */
const api = {
  /**
   * 認証トークン付きfetchラッパー
   * @param {string} path - APIパス（/api/v1 以降）
   * @param {object} options - fetch オプション
   * @returns {Promise<object>} レスポンスJSON
   */
  async request(path, options = {}) {
    const token = localStorage.getItem('nuriel_token');
    const headers = {
      ...(options.headers || {}),
    };

    // FormData の場合は Content-Type を設定しない（ブラウザが boundary を付与）
    if (!(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    try {
      const res = await fetch(`${CONFIG.API_BASE}${path}`, {
        ...options,
        headers,
      });

      // 401: トークン無効 → ログアウト
      if (res.status === 401) {
        auth.logout();
        throw new Error('セッションが切れました。再度ログインしてください。');
      }

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || data.message || `エラーが発生しました（${res.status}）`);
      }

      return data;
    } catch (err) {
      // ネットワークエラー
      if (err.name === 'TypeError' && (err.message.includes('fetch') || err.message.includes('Failed') || err.message.includes('NetworkError'))) {
        throw new Error(CONFIG.ERRORS.NETWORK_ERROR);
      }
      throw err;
    }
  },

  get(path) {
    return this.request(path);
  },

  post(path, body) {
    const isFormData = body instanceof FormData;
    return this.request(path, {
      method: 'POST',
      body: isFormData ? body : JSON.stringify(body),
    });
  },

  delete(path) {
    return this.request(path, { method: 'DELETE' });
  },
};

/* ==============================================
   認証モジュール
   ============================================== */
const auth = {
  /** 認証済みかどうか */
  isLoggedIn() {
    return !!localStorage.getItem('nuriel_token');
  },

  /** ユーザー情報をローカルに保存 */
  _saveSession(data) {
    localStorage.setItem('nuriel_token', data.token);
    localStorage.setItem('nuriel_user', JSON.stringify(data.user));
  },

  /** ユーザー情報を取得 */
  getUser() {
    try {
      return JSON.parse(localStorage.getItem('nuriel_user'));
    } catch {
      return null;
    }
  },

  /** ログイン */
  async login(email, password) {
    const data = await api.post('/auth/login', { email, password });
    this._saveSession(data);
    return data;
  },

  /** 新規登録 */
  async register(email, password) {
    const data = await api.post('/auth/register', { email, password });
    this._saveSession(data);
    return data;
  },

  /** ログアウト */
  logout() {
    // サーバー側セッションも削除（非同期、失敗しても続行）
    const token = localStorage.getItem('nuriel_token');
    if (token && token !== 'test_token_demo') {
      fetch(`${CONFIG.API_BASE}/auth/logout`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }).catch(() => { /* ログアウトAPI失敗は無視 */ });
    }
    localStorage.removeItem('nuriel_token');
    localStorage.removeItem('nuriel_user');
    ui.showAuth();
  },

  /** セッションを検証（ページ読み込み時） */
  async verify() {
    if (!this.isLoggedIn()) return false;
    try {
      const data = await api.get('/auth/me');
      localStorage.setItem('nuriel_user', JSON.stringify(data.user));
      return true;
    } catch {
      this.logout();
      return false;
    }
  },
};

/* ==============================================
   アプリ状態
   ============================================== */
const state = {
  currentScreen: 'home',
  selectedFile: null,
  selectedStyle: 'standard',
  gallery: [],
  user: null,
  plan: {
    name: 'おためし',
    remaining: 3,
    total: 3,
  },
  /* 二重送信防止フラグ */
  isConverting: false,
  isUploading: false,
};

/* ==============================================
   Stripe & Payment Request API
   ============================================== */
let stripeInstance = null;
let paymentRequest = null;

/**
 * Stripe.jsを初期化し、Apple Pay / Google Pay の利用可否を検出
 */
async function initStripePaymentRequest() {
  /* Stripe.js未ロードまたは公開鍵未設定時はスキップ */
  if (typeof Stripe === 'undefined') return;

  /* 公開鍵を取得（CONFIGまたはmeta tagから） */
  const pk = CONFIG.STRIPE_PUBLISHABLE_KEY
    || document.querySelector('meta[name="stripe-key"]')?.content;
  if (!pk) {
    /* 公開鍵未設定 = モックモード。バッジは表示しておく */
    detectPaymentMethodsFromBrowser();
    return;
  }

  try {
    stripeInstance = Stripe(pk);

    /* Payment Request オブジェクト作成（Apple Pay / Google Pay 検出用） */
    paymentRequest = stripeInstance.paymentRequest({
      country: 'JP',
      currency: 'jpy',
      total: {
        label: 'ヌリエル プラン',
        amount: 100, /* ダミー金額。実際のCheckoutで確定 */
      },
      requestPayerName: true,
      requestPayerEmail: true,
    });

    /* Apple Pay / Google Pay が利用可能かチェック */
    const result = await paymentRequest.canMakePayment();
    if (result) {
      if (result.applePay) {
        showPaymentBadge('applePay');
      }
      if (result.googlePay) {
        showPaymentBadge('googlePay');
      }
      /* Payment Request Button をマウント（プラン画面用） */
      mountPaymentRequestButton();
    }
  } catch (err) {
    console.warn('Stripe Payment Request 初期化エラー:', err.message);
    /* フォールバック: ブラウザのみで検出 */
    detectPaymentMethodsFromBrowser();
  }
}

/**
 * ブラウザのUser-Agentとプラットフォームから決済方法を推定表示
 * Stripe.js未ロード時のフォールバック
 */
function detectPaymentMethodsFromBrowser() {
  const ua = navigator.userAgent.toLowerCase();
  const isIOS = /iphone|ipad|ipod/.test(ua);
  const isSafari = /safari/.test(ua) && !/chrome/.test(ua);
  const isMac = /macintosh/.test(ua);

  /* Safari（iOS/macOS）ならApple Pay表示 */
  if ((isIOS || (isMac && isSafari)) && window.ApplePaySession) {
    showPaymentBadge('applePay');
  }

  /* Android ChromeならGoogle Pay表示 */
  const isAndroid = /android/.test(ua);
  const isChrome = /chrome/.test(ua) && !/edge/.test(ua);
  if (isAndroid && isChrome) {
    showPaymentBadge('googlePay');
  }
}

/**
 * 決済方法バッジを表示
 * @param {'applePay'|'googlePay'} method
 */
function showPaymentBadge(method) {
  if (method === 'applePay') {
    const badge = document.getElementById('badgeApplePay');
    if (badge) badge.classList.remove('hidden');
  } else if (method === 'googlePay') {
    const badge = document.getElementById('badgeGooglePay');
    if (badge) badge.classList.remove('hidden');
  }
}

/**
 * Payment Request Button をプラン画面にマウント
 */
function mountPaymentRequestButton() {
  if (!stripeInstance || !paymentRequest) return;

  const container = document.getElementById('paymentRequestButtonContainer');
  if (!container) return;

  const elements = stripeInstance.elements();
  const prButton = elements.create('paymentRequestButton', {
    paymentRequest,
    style: {
      paymentRequestButton: {
        type: 'default',
        theme: 'dark',
        height: '48px',
      },
    },
  });

  container.style.display = 'block';
  prButton.mount('#payment-request-button');

  /* Payment Request のトークン取得時はCheckout APIに送信 */
  paymentRequest.on('paymentmethod', async (ev) => {
    /* Stripe Checkoutにリダイレクトする方式のため、
       ここではイベントをキャンセルしてCheckoutに誘導 */
    ev.complete('success');
    showToast('Stripe Checkoutに移動します...');
    /* たっぷりプランのCheckoutを開く */
    handlePlanChange('たっぷり');
  });
}

/* ==============================================
   ボタンフィードバック（100msスピナー→チェックマーク→元に戻る）
   ============================================== */
/**
 * ボタンにローディング→成功→元に戻るフィードバックを付与
 * @param {HTMLButtonElement} btn - 対象ボタン
 * @param {Function} asyncFn - 実行する非同期処理
 * @returns {Promise<*>} asyncFnの戻り値
 */
async function withButtonFeedback(btn, asyncFn) {
  if (!btn || btn.disabled) return;
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.classList.add('btn-feedback', 'feedback-loading');

  try {
    const result = await asyncFn();
    /* 成功: チェックマーク表示 */
    btn.classList.remove('feedback-loading');
    btn.innerHTML = '<span style="color:transparent">' + originalText + '</span>';
    btn.classList.add('feedback-success');
    await new Promise(r => setTimeout(r, 800));
    return result;
  } catch (err) {
    throw err;
  } finally {
    /* 元に戻す */
    btn.classList.remove('btn-feedback', 'feedback-loading', 'feedback-success');
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}

/* ==============================================
   オフライン検知・通知バー
   ============================================== */
function initOfflineDetection() {
  const bar = document.getElementById('offlineBar');
  if (!bar) return;

  function updateStatus() {
    if (!navigator.onLine) {
      bar.classList.add('show');
    } else {
      bar.classList.remove('show');
    }
  }
  window.addEventListener('online', updateStatus);
  window.addEventListener('offline', updateStatus);
  updateStatus();
}

/* ==============================================
   キーボード操作（Escでモーダル閉じ）
   ============================================== */
function initKeyboardHandlers() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      /* ギャラリーモーダル */
      const galleryModal = document.getElementById('galleryModal');
      if (galleryModal && galleryModal.classList.contains('show')) {
        galleryModal.classList.remove('show');
        return;
      }
      /* Embedded Checkoutモーダル */
      const checkoutModal = document.getElementById('nuriel-checkout-modal');
      if (checkoutModal) {
        closeNurielCheckoutModal();
        return;
      }
      /* 変換中オーバーレイは閉じない（処理中のため） */
    }
  });
}

/* ==============================================
   ページローダー制御
   ============================================== */
function hidePageLoader() {
  const loader = document.getElementById('pageLoader');
  if (loader) {
    loader.classList.add('fade-out');
    setTimeout(() => loader.remove(), 300);
  }
}

/* ==============================================
   トースト通知
   ============================================== */
function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${message}</span>`;
  container.appendChild(toast);
  // アニメーション後に自動削除
  setTimeout(() => toast.remove(), 3200);
}

/* ==============================================
   UI モジュール
   ============================================== */
const ui = {
  /** 認証画面を表示 */
  showAuth(mode = 'login') {
    const overlay = document.getElementById('authOverlay');
    overlay.classList.remove('hidden');
    document.querySelector('.app-wrapper').style.filter = 'blur(4px)';
    this._setAuthMode(mode);
  },

  /** 認証画面を非表示 */
  hideAuth() {
    const overlay = document.getElementById('authOverlay');
    overlay.classList.add('hidden');
    document.querySelector('.app-wrapper').style.filter = 'none';
  },

  /** 認証モード切替（ログイン ↔ 新規登録） */
  _setAuthMode(mode) {
    const title = document.getElementById('authTitle');
    const submitBtn = document.getElementById('authSubmitBtn');
    const switchText = document.getElementById('authSwitch');
    const termsGroup = document.getElementById('authTermsGroup');
    const pwStrength = document.getElementById('authPwStrength');

    if (mode === 'login') {
      title.textContent = 'ログイン';
      submitBtn.textContent = 'ログイン';
      switchText.innerHTML = 'アカウントをお持ちでない方は <a href="#register" id="authToggle" role="button">新規登録はこちら</a>';
      if (termsGroup) termsGroup.style.display = 'none';
      if (pwStrength) pwStrength.style.display = 'none';
    } else {
      title.textContent = '新規登録';
      submitBtn.textContent = '無料で始める';
      switchText.innerHTML = 'アカウントをお持ちの方は <a href="#login" id="authToggle" role="button">ログインはこちら</a>';
      if (termsGroup) termsGroup.style.display = 'block';
      if (pwStrength) pwStrength.style.display = 'block';
    }

    // 切替リンクにイベント
    document.getElementById('authToggle').addEventListener('click', (e) => {
      e.preventDefault();
      this._setAuthMode(mode === 'login' ? 'register' : 'login');
    });

    // 現在のモードを保存
    document.getElementById('authForm').dataset.mode = mode;
    // エラーをクリア
    document.getElementById('authEmailError').textContent = '';
    document.getElementById('authPasswordError').textContent = '';
  },

  /** 画面を切り替え（hash-based routing） */
  navigate(screen) {
    if (screen !== state.currentScreen) {
      window.location.hash = screen;
    }
  },

  /** 画面を実際に反映 */
  _renderScreen(screen) {
    state.currentScreen = screen;

    // 全画面を非表示
    document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
    // 対象画面を表示
    const target = document.getElementById(`screen-${screen}`);
    if (target) target.classList.add('active');

    // ナビのアクティブ状態更新（aria-current含む）
    document.querySelectorAll('.nav-item').forEach((el) => {
      const isActive = el.dataset.screen === screen;
      el.classList.toggle('active', isActive);
      if (isActive) {
        el.setAttribute('aria-current', 'page');
      } else {
        el.removeAttribute('aria-current');
      }
    });

    // 画面固有の初期化
    if (screen === 'gallery') gallery.load();
    if (screen === 'plan') planUI.render();
    if (screen === 'settings') settingsUI.render();
  },

  /** 残り回数を更新 */
  updateRemaining() {
    const badge = document.getElementById('remainingBadge');
    badge.textContent = `今月あと ${state.plan.remaining} 枚`;
  },
};

/* ==============================================
   画面ルーティング
   ============================================== */
function initRouter() {
  const handleHash = () => {
    const hash = window.location.hash.replace('#', '') || 'home';
    const allowed = ['home', 'gallery', 'plan', 'settings'];
    const screen = allowed.includes(hash) ? hash : 'home';
    ui._renderScreen(screen);
  };

  window.addEventListener('hashchange', handleHash);
  handleHash();
}

/* ==============================================
   写真アップロードモジュール
   ============================================== */
const uploader = {
  init() {
    const area = document.getElementById('uploadArea');
    const fileInput = document.getElementById('fileInput');
    const preview = document.getElementById('previewContainer');
    const previewImg = document.getElementById('previewImg');
    const previewName = document.getElementById('previewName');
    const changeBtn = document.getElementById('previewChange');

    // ドラッグ&ドロップ
    area.addEventListener('dragover', (e) => {
      e.preventDefault();
      area.classList.add('dragover');
    });
    area.addEventListener('dragleave', () => {
      area.classList.remove('dragover');
    });
    area.addEventListener('drop', (e) => {
      e.preventDefault();
      area.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file) this._handleFile(file);
    });

    // ファイル選択（ライブラリから）
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) this._handleFile(file);
    });

    // カメラ入力
    const cameraInput = document.getElementById('cameraInput');
    if (cameraInput) {
      cameraInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) this._handleFile(file);
      });
    }

    // 「写真から選ぶ」ボタン
    const btnLibrary = document.getElementById('btnFromLibrary');
    if (btnLibrary) {
      btnLibrary.addEventListener('click', (e) => {
        e.stopPropagation();
        fileInput.click();
      });
    }

    // 「カメラで撮る」ボタン
    const btnCamera = document.getElementById('btnFromCamera');
    if (btnCamera) {
      btnCamera.addEventListener('click', (e) => {
        e.stopPropagation();
        if (cameraInput) cameraInput.click();
      });
    }

    // 写真変更ボタン
    changeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      fileInput.value = '';
      state.selectedFile = null;
      preview.classList.remove('show');
      area.style.display = 'block';
    });
  },

  /** ファイルを検証してプレビュー表示 */
  _handleFile(file) {
    // 二重アップロード防止
    if (state.isUploading) return;

    // 形式チェック（HEICはtype空の場合もあるので拡張子でも判定）
    const ext = file.name.toLowerCase().split('.').pop();
    const isHeic = ext === 'heic' || ext === 'heif';
    if (!CONFIG.ACCEPTED_TYPES.includes(file.type) && !isHeic) {
      showToast(CONFIG.ERRORS.INVALID_FORMAT, 'error');
      return;
    }
    // サイズチェック
    if (file.size > CONFIG.MAX_FILE_SIZE) {
      showToast(CONFIG.ERRORS.FILE_TOO_LARGE, 'error');
      return;
    }

    state.isUploading = true;
    state.selectedFile = file;

    // アップロードボタンにローディング表示
    const btnLibrary = document.getElementById('btnFromLibrary');
    const btnCamera = document.getElementById('btnFromCamera');
    if (btnLibrary) btnLibrary.classList.add('loading');
    if (btnCamera) btnCamera.classList.add('loading');

    // 進捗バー表示
    const progressWrap = document.getElementById('uploadProgressWrap');
    const progressFill = document.getElementById('uploadProgressFill');
    const progressText = document.getElementById('uploadProgressText');
    if (progressWrap) {
      progressWrap.classList.add('show');
      progressFill.style.width = '0%';
      progressText.textContent = '画像を読み込んでいます...';
    }

    // プレビュー表示（高速化: createObjectURL使用）
    const objectUrl = URL.createObjectURL(file);
    const previewImg = document.getElementById('previewImg');
    previewImg.src = objectUrl;

    // 画像読み込み完了後にプレビュー表示
    previewImg.onload = () => {
      // 進捗100%
      if (progressFill) progressFill.style.width = '100%';
      if (progressText) progressText.textContent = '読み込み完了';

      setTimeout(() => {
        document.getElementById('previewName').textContent = file.name;
        document.getElementById('previewContainer').classList.add('show');
        document.getElementById('uploadArea').style.display = 'none';
        if (progressWrap) progressWrap.classList.remove('show');

        // ローディング解除
        if (btnLibrary) btnLibrary.classList.remove('loading');
        if (btnCamera) btnCamera.classList.remove('loading');
        state.isUploading = false;
      }, 300);
    };

    // 読み込み進捗シミュレーション（ObjectURLは即座に読み込まれるため）
    if (progressFill) {
      let prog = 0;
      const progInterval = setInterval(() => {
        prog = Math.min(prog + 20, 90);
        progressFill.style.width = `${prog}%`;
        if (prog >= 90) clearInterval(progInterval);
      }, 50);
    }

    // エラー時
    previewImg.onerror = () => {
      showToast(CONFIG.ERRORS.INVALID_FORMAT, 'error');
      if (progressWrap) progressWrap.classList.remove('show');
      if (btnLibrary) btnLibrary.classList.remove('loading');
      if (btnCamera) btnCamera.classList.remove('loading');
      state.isUploading = false;
      state.selectedFile = null;
      URL.revokeObjectURL(objectUrl);
    };
  },
};

/* ==============================================
   スタイル選択
   ============================================== */
function initStyleSelector() {
  const options = document.querySelectorAll('.style-option');
  options.forEach((opt) => {
    opt.addEventListener('click', () => {
      // ロックされたスタイルはクリック不可
      if (opt.classList.contains('locked')) {
        showToast('このスタイルは「たっぷり」プランで利用できます', 'error');
        return;
      }
      // 選択を切替
      options.forEach((o) => {
        o.classList.remove('selected');
        o.setAttribute('aria-checked', 'false');
      });
      opt.classList.add('selected');
      opt.setAttribute('aria-checked', 'true');
      state.selectedStyle = opt.dataset.style;
    });
    // キーボード操作対応（EnterとSpace）
    opt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        opt.click();
      }
    });
  });
}

/* ==============================================
   線画変換モジュール
   ============================================== */
const converter = {
  /** 変換リクエストを送信し、ポーリングで完了を待つ */
  async generate() {
    // 二重送信防止
    if (state.isConverting) return;

    if (!state.selectedFile) {
      showToast(CONFIG.ERRORS.NO_IMAGE, 'error');
      return;
    }
    if (state.plan.remaining <= 0) {
      showToast(CONFIG.ERRORS.QUOTA_EXCEEDED, 'error');
      return;
    }

    state.isConverting = true;

    const overlay = document.getElementById('convertingOverlay');
    const progressFill = document.getElementById('progressFill');
    const convertingText = document.getElementById('convertingText');
    const btnGenerate = document.getElementById('btnGenerate');

    // 変換ボタンにスピナー+テキスト表示
    const originalBtnText = btnGenerate.textContent;
    btnGenerate.innerHTML = '<span class="btn-spinner"></span>変換中...';
    btnGenerate.classList.add('loading-with-text');
    btnGenerate.disabled = true;

    // 変換中オーバーレイ表示
    overlay.classList.add('show');
    progressFill.style.width = '0%';

    // ページ離脱警告を設定
    const beforeUnloadHandler = (e) => {
      e.preventDefault();
      e.returnValue = '変換中です。ページを離れると変換が中断されます。';
      return e.returnValue;
    };
    window.addEventListener('beforeunload', beforeUnloadHandler);

    const messages = [
      '線画をつくっています...',
      'ペットの輪郭を抽出中...',
      '細部を仕上げています...',
      'もう少しで完成です...',
    ];

    try {
      // (1) 画像アップロード
      const formData = new FormData();
      formData.append('image', state.selectedFile);

      let uploadResult;
      try {
        uploadResult = await api.post('/upload', formData);
      } catch (uploadErr) {
        throw new Error(CONFIG.ERRORS.UPLOAD_FAIL);
      }
      const imageKey = uploadResult.imageKey;

      // (2) 線画変換リクエスト送信
      const convertResult = await api.post('/convert', {
        imageKey,
        style: state.selectedStyle,
      });
      const generationId = convertResult.generationId;

      // (3) ポーリングでステータス確認
      let retries = 0;
      const poll = async () => {
        if (retries >= CONFIG.POLL_MAX_RETRIES) {
          throw new Error(CONFIG.ERRORS.CONVERT_TIMEOUT);
        }

        const progress = Math.min(10 + retries * 3, 95);
        progressFill.style.width = `${progress}%`;
        convertingText.textContent = messages[Math.min(Math.floor(retries / 5), messages.length - 1)];

        const result = await api.get(`/convert/${generationId}/status`);

        if (result.status === 'completed') {
          progressFill.style.width = '100%';
          const fullResult = await api.get(`/convert/${generationId}/result`);
          return fullResult;
        }
        if (result.status === 'failed') {
          throw new Error(CONFIG.ERRORS.CONVERT_FAIL);
        }

        retries++;
        return new Promise((resolve) => setTimeout(() => resolve(poll()), CONFIG.POLL_INTERVAL));
      };

      const result = await poll();

      // (4) 結果表示
      overlay.classList.remove('show');
      this._showResult(result);

      // 残り回数を減らす
      state.plan.remaining = Math.max(0, state.plan.remaining - 1);
      ui.updateRemaining();

      showToast('塗り絵が完成しました！');

    } catch (err) {
      overlay.classList.remove('show');
      // ネットワークエラーの場合は親切メッセージ
      const msg = (err.message.includes('fetch') || err.message.includes('NetworkError'))
        ? CONFIG.ERRORS.NETWORK_ERROR
        : err.message;
      showToast(msg, 'error');
    } finally {
      // ページ離脱警告を解除
      window.removeEventListener('beforeunload', beforeUnloadHandler);
      // ボタンを元に戻す
      btnGenerate.textContent = originalBtnText;
      btnGenerate.classList.remove('loading-with-text');
      btnGenerate.disabled = false;
      state.isConverting = false;
    }
  },

  /** 変換結果を表示 */
  _showResult(result) {
    const section = document.getElementById('resultSection');
    const img = document.getElementById('resultPreview');
    const genId = result.generationId;

    // 線画結果の取得（/api/convert/:id/result で画像取得）
    // resultにlineArtBase64がある場合はそれを使用、なければAPIからプロキシ
    if (result.lineArtBase64) {
      img.src = result.lineArtBase64;
    } else {
      img.src = `${CONFIG.API_BASE}/convert/${genId}/result`;
    }
    section.classList.add('show');

    // PDFダウンロードボタン（二重送信防止付き）
    const btnPdf = document.getElementById('btnDownloadPdf');
    btnPdf.onclick = () => {
      withButtonFeedback(btnPdf, async () => {
        const token = localStorage.getItem('nuriel_token');
        const res = await fetch(`${CONFIG.API_BASE}/pdf/${genId}`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(CONFIG.ERRORS.PDF_FAIL);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `nuriel-${genId}.pdf`;
        a.click();
        URL.revokeObjectURL(url);
      }).catch(err => showToast(err.message || CONFIG.ERRORS.PDF_FAIL, 'error'));
    };

    // ギャラリーに保存（二重送信防止付き）
    const btnSave = document.getElementById('btnSaveGallery');
    btnSave.onclick = () => {
      withButtonFeedback(btnSave, async () => {
        await new Promise(r => setTimeout(r, 100));
      }).then(() => showToast('ギャラリーに保存済みです'));
    };
  },
};

/* ==============================================
   ギャラリーモジュール
   ============================================== */
const gallery = {
  async load() {
    const grid = document.getElementById('galleryGrid');
    const empty = document.getElementById('galleryEmpty');

    try {
      const { items } = await api.get('/gallery');
      state.gallery = items || [];
    } catch {
      state.gallery = [];
    }

    if (state.gallery.length === 0) {
      grid.style.display = 'none';
      empty.style.display = 'block';
      return;
    }

    grid.style.display = 'grid';
    empty.style.display = 'none';

    grid.innerHTML = state.gallery.map((item) => {
      const dataSrc = item.lineArtUrl || '';
      return `
      <div class="gallery-item" data-id="${item.id}">
        <img data-src="${dataSrc}" alt="塗り絵" loading="lazy"
             style="min-height:100px;background:#f0f0f0;">
        <div class="gallery-item-date">${new Date(item.createdAt).toLocaleDateString('ja-JP')}</div>
      </div>
    `;
    }).join('');

    // 認証トークン付きで画像を読み込み（data:URL既設定の場合はスキップ）
    // /api/convert/:id/result はJSONを返す（lineArtBase64フィールドにdata:URL形式の画像が含まれる）
    const token = localStorage.getItem('nuriel_token');
    grid.querySelectorAll('.gallery-item img[data-src]').forEach(async (img) => {
      const src = img.dataset.src;
      if (!src || img.src.startsWith('data:')) return;
      try {
        const res = await fetch(`${CONFIG.API_BASE}${src}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        });
        if (res.ok) {
          const data = await res.json();
          if (data.lineArtBase64) {
            img.src = data.lineArtBase64;
          }
        }
      } catch {
        // 画像読み込み失敗は無視
      }
    });

    // クリックで詳細表示
    grid.querySelectorAll('.gallery-item').forEach((el) => {
      el.addEventListener('click', () => {
        const item = state.gallery.find((i) => i.id === el.dataset.id);
        if (item) this._showDetail(item);
      });
    });
  },

  /** 詳細モーダル表示 */
  _showDetail(item) {
    const modal = document.getElementById('galleryModal');
    const modalImg = document.getElementById('galleryModalImg');
    modal.classList.add('show');

    // lineArtDataUrl（デモモード）がある場合は直接表示
    if (item.lineArtDataUrl) {
      modalImg.src = item.lineArtDataUrl;
    } else if (item.lineArtUrl) {
      // 認証トークン付きでJSON APIから画像を取得
      const token = localStorage.getItem('nuriel_token');
      fetch(`${CONFIG.API_BASE}${item.lineArtUrl}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })
        .then(res => res.ok ? res.json() : Promise.reject())
        .then(data => { modalImg.src = data.lineArtBase64 || ''; })
        .catch(() => { modalImg.src = ''; });
    } else {
      modalImg.src = '';
    }

    const modalBtnDl = document.getElementById('modalBtnDownload');
    modalBtnDl.onclick = () => {
      if (!item.pdfUrl) {
        showToast('PDFがまだ生成されていません', 'error');
        return;
      }
      withButtonFeedback(modalBtnDl, async () => {
        const token = localStorage.getItem('nuriel_token');
        const res = await fetch(`${CONFIG.API_BASE}${item.pdfUrl}`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(CONFIG.ERRORS.PDF_FAIL);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `nuriel-${item.id}.pdf`;
        a.click();
        URL.revokeObjectURL(url);
      }).catch(err => showToast(err.message || CONFIG.ERRORS.PDF_FAIL, 'error'));
    };

    // 削除（二重送信防止付き）
    const modalBtnDel = document.getElementById('modalBtnDelete');
    modalBtnDel.onclick = async () => {
      if (!confirm('この塗り絵を削除しますか？')) return;
      withButtonFeedback(modalBtnDel, async () => {
        await api.delete(`/gallery/${item.id}`);
        modal.classList.remove('show');
        showToast('削除しました');
        this.load();
      }).catch(err => showToast(err.message, 'error'));
    };

    // モーダル閉じる
    document.getElementById('modalBtnClose').onclick = () => {
      modal.classList.remove('show');
    };
    // 背景クリックで閉じる
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.remove('show');
    }, { once: true });
  },
};

/* ==============================================
   プラン画面モジュール
   ============================================== */
const planUI = {
  render() {
    const nameEl = document.getElementById('currentPlanName');
    const detailEl = document.getElementById('currentPlanDetail');

    nameEl.textContent = state.plan.name || '無料体験';
    detailEl.textContent = `今月の残り: ${state.plan.remaining} / ${state.plan.total} 枚`;

    // ボタンの状態更新
    const btnOtameshi = document.getElementById('btnPlanOtameshi');
    const btnTappuri = document.getElementById('btnPlanTappuri');

    const planName = state.plan.name;

    // 無料体験カードの表示制御
    const freeCard = document.getElementById('planFreeCard');
    const freeLabel = document.getElementById('planFreeLabel');
    if (freeCard && freeLabel) {
      if (planName === '無料体験' || planName === 'free') {
        freeCard.style.display = '';
        freeLabel.textContent = '現在のプラン';
      } else {
        freeCard.style.display = 'none';
      }
    }

    if (planName === 'たっぷり') {
      // たっぷりプラン利用中
      btnOtameshi.textContent = 'ダウングレード';
      btnOtameshi.className = 'btn-plan btn-plan-upgrade btn-plan-downgrade';
      btnTappuri.textContent = '利用中';
      btnTappuri.className = 'btn-plan btn-plan-current';
    } else if (planName === 'おためし') {
      // おためしプラン利用中
      btnOtameshi.textContent = '利用中';
      btnOtameshi.className = 'btn-plan btn-plan-current';
      btnTappuri.textContent = 'アップグレード';
      btnTappuri.className = 'btn-plan btn-plan-upgrade';
    } else {
      // 無料体験プラン（freeプラン）
      btnOtameshi.textContent = 'アップグレード';
      btnOtameshi.className = 'btn-plan btn-plan-upgrade';
      btnTappuri.textContent = 'アップグレード';
      btnTappuri.className = 'btn-plan btn-plan-upgrade';
    }
  },
};

/* ==============================================
   設定画面モジュール
   ============================================== */
const settingsUI = {
  render() {
    const user = auth.getUser();
    if (user) {
      document.getElementById('settingsDisplayName').textContent = user.displayName || '未設定';
      document.getElementById('settingsEmail').textContent = user.email || '';
    }
  },
};

/* ==============================================
   イベントバインド
   ============================================== */
function bindEvents() {
  // --- 認証フォーム ---
  document.getElementById('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const mode = form.dataset.mode;
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const btn = document.getElementById('authSubmitBtn');

    // バリデーション
    let valid = true;
    const emailError = document.getElementById('authEmailError');
    const passError = document.getElementById('authPasswordError');
    emailError.textContent = '';
    passError.textContent = '';

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      emailError.textContent = '有効なメールアドレスを入力してください';
      valid = false;
    }
    if (!password || password.length < 8) {
      passError.textContent = 'パスワードは8文字以上で入力してください';
      valid = false;
    }
    if (!valid) return;

    // 新規登録時の追加チェック
    if (mode === 'register') {
      if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
        passError.textContent = 'パスワードは英字と数字の両方を含めてください';
        return;
      }
      const termsCheck = document.getElementById('authTerms');
      if (termsCheck && !termsCheck.checked) {
        document.getElementById('authTermsError').textContent = '利用規約への同意が必要です';
        return;
      }
    }

    btn.classList.add('loading');
    btn.disabled = true;

    try {
      if (mode === 'login') {
        await auth.login(email, password);
      } else {
        await auth.register(email, password);
      }
      state.user = auth.getUser();
      ui.hideAuth();
      showToast(mode === 'login' ? 'ログインしました' : 'アカウントを作成しました');
      initAppData();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  });

  // --- 認証パスワード強度チェック ---
  document.getElementById('authPassword').addEventListener('input', function() {
    const pw = this.value;
    const el = document.getElementById('authPwStrength');
    const mode = document.getElementById('authForm').dataset.mode;
    if (!el || mode === 'login') return;
    if (pw.length === 0) { el.textContent = ''; }
    else if (pw.length < 8) { el.textContent = 'あと' + (8 - pw.length) + '文字必要です'; el.style.color = '#dc2626'; }
    else if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) { el.textContent = '英字と数字の両方を含めてください'; el.style.color = '#d97706'; }
    else { el.textContent = 'OK'; el.style.color = '#16a34a'; }
  });

  // --- ナビゲーション ---
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.addEventListener('click', () => {
      ui.navigate(el.dataset.screen);
    });
  });

  // --- 変換ボタン ---
  document.getElementById('btnGenerate').addEventListener('click', () => {
    converter.generate();
  });

  // --- 月額/年額切り替えトグル（アプリ内） ---
  document.querySelectorAll('#appBillingToggle .billing-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#appBillingToggle .billing-toggle-btn').forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
      const period = btn.dataset.period;
      const nameOtameshi = document.getElementById('appPlanNameOtameshi');
      const descOtameshi = document.getElementById('appPlanDescOtameshi');
      const nameTappuri = document.getElementById('appPlanNameTappuri');
      const descTappuri = document.getElementById('appPlanDescTappuri');
      if (period === 'yearly') {
        nameOtameshi.textContent = 'おためし — ¥1,000/年';
        descOtameshi.textContent = '月3枚 / 基本スタイル2種 / 月額換算¥83';
        nameTappuri.textContent = 'たっぷり — ¥3,000/年';
        descTappuri.textContent = '月20枚 / 全4スタイル / 月額換算¥250';
      } else {
        nameOtameshi.textContent = 'おためし — ¥100/月';
        descOtameshi.textContent = '月3枚 / 基本スタイル2種 / 年額¥1,000（2ヶ月おトク）';
        nameTappuri.textContent = 'たっぷり — ¥300/月';
        descTappuri.textContent = '月20枚 / 全4スタイル / 年額¥3,000（2ヶ月おトク）';
      }
    });
  });

  // --- プランボタン ---
  document.getElementById('btnPlanOtameshi').addEventListener('click', () => {
    handlePlanChange('おためし');
  });
  document.getElementById('btnPlanTappuri').addEventListener('click', () => {
    handlePlanChange('たっぷり');
  });

  // --- 設定: パスワード変更（フォーム表示トグル） ---
  document.getElementById('btnChangePassword').addEventListener('click', () => {
    const form = document.getElementById('password-change-form');
    form.style.display = form.style.display === 'none' ? 'block' : 'none';
  });

  // パスワード強度チェック（リアルタイム）
  document.getElementById('settingsNewPw').addEventListener('input', function() {
    const pw = this.value;
    const el = document.getElementById('settingsPwStrength');
    if (pw.length === 0) { el.textContent = '8文字以上、英字と数字を含めてください'; el.style.color = '#999'; }
    else if (pw.length < 8) { el.textContent = 'あと' + (8 - pw.length) + '文字必要です'; el.style.color = '#dc2626'; }
    else if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) { el.textContent = '英字と数字の両方を含めてください'; el.style.color = '#d97706'; }
    else { el.textContent = 'パスワード強度: OK'; el.style.color = '#16a34a'; }
  });

  // パスワード変更: Enterキーで送信
  ['settingsCurrentPw', 'settingsNewPw', 'settingsConfirmPw'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          document.getElementById('btnSubmitPassword').click();
        }
      });
    }
  });

  // パスワード変更送信
  document.getElementById('btnSubmitPassword').addEventListener('click', async () => {
    const btn = document.getElementById('btnSubmitPassword');
    const currentPw = document.getElementById('settingsCurrentPw').value;
    const newPw = document.getElementById('settingsNewPw').value;
    const confirmPw = document.getElementById('settingsConfirmPw').value;
    if (!currentPw) { showToast('現在のパスワードを入力してください', 'error'); return; }
    if (!newPw || newPw.length < 8) { showToast('新しいパスワードは8文字以上で入力してください', 'error'); return; }
    if (!/[a-zA-Z]/.test(newPw) || !/[0-9]/.test(newPw)) { showToast('パスワードは英字と数字の両方を含めてください', 'error'); return; }
    if (newPw !== confirmPw) { showToast('新しいパスワードが一致しません', 'error'); return; }

    withButtonFeedback(btn, async () => {
      await api.request('/auth/password', { method: 'PUT', body: JSON.stringify({ current_password: currentPw, new_password: newPw }) });
      showToast('パスワードを変更しました');
      document.getElementById('settingsCurrentPw').value = '';
      document.getElementById('settingsNewPw').value = '';
      document.getElementById('settingsConfirmPw').value = '';
      document.getElementById('password-change-form').style.display = 'none';
    }).catch(err => showToast(err.message || 'パスワード変更に失敗しました。現在のパスワードが正しいか確認してください。', 'error'));
  });

  // --- 設定: ログアウト ---
  document.getElementById('btnLogout').addEventListener('click', () => {
    if (confirm('ログアウトしますか？')) {
      auth.logout();
    }
  });

  // --- 設定: 退会 ---
  document.getElementById('btnWithdraw').addEventListener('click', () => {
    if (confirm('退会すると全データが削除されます。本当に退会しますか？')) {
      handleWithdraw();
    }
  });

  // --- 新しい塗り絵を作るボタン ---
  document.getElementById('btnNewConvert').addEventListener('click', () => {
    // 結果をリセット
    document.getElementById('resultSection').classList.remove('show');
    document.getElementById('previewContainer').classList.remove('show');
    document.getElementById('uploadArea').style.display = 'block';
    document.getElementById('fileInput').value = '';
    state.selectedFile = null;
  });
}

/** Embedded Checkout モーダルを閉じる */
function closeNurielCheckoutModal() {
  const modal = document.getElementById('nuriel-checkout-modal');
  if (modal) modal.remove();
  if (window._nuriel_embedded_checkout) {
    window._nuriel_embedded_checkout.destroy();
    window._nuriel_embedded_checkout = null;
  }
}

/** プラン変更処理（Embedded Checkout方式 — ページ内決済） */
async function handlePlanChange(planName) {
  if (state.plan.name === planName) return;

  /* ボタンをローディング状態にする（disabled + 「処理中...」テキスト） */
  const btnId = planName === 'たっぷり' ? 'btnPlanTappuri' : 'btnPlanOtameshi';
  const btn = document.getElementById(btnId);
  let originalBtnText = '';
  if (btn) {
    originalBtnText = btn.textContent;
    btn.textContent = '処理中...';
    btn.classList.add('loading');
    btn.disabled = true;
  }

  try {
    const planIdMap = { 'おためし': 'otameshi', 'たっぷり': 'tappuri' };
    const planId = planIdMap[planName];
    if (!planId) return;

    /* ユーザーが選択した請求期間を取得 */
    const activeToggle = document.querySelector('#appBillingToggle .billing-toggle-btn.active');
    const billingPeriod = activeToggle ? activeToggle.dataset.period : 'monthly';

    const result = await api.post('/billing/checkout', {
      plan_id: planId,
      billing_period: billingPeriod,
    });

    if (result.mock) {
      /* モックモード: 即座にプラン切替 */
      state.plan.name = planName;
      state.plan.total = planName === 'たっぷり' ? 20 : 3;
      planUI.render();
      updateStyleLocks();
      showToast(`${planName}プランに変更しました`);
    } else if (result.clientSecret) {
      /* Stripe公開鍵を取得 */
      const keyRes = await fetch('/api/billing/stripe-key');
      const keyData = await keyRes.json();
      if (!keyData.publishableKey) {
        /* 公開鍵未設定 → 環境変数またはmeta tagから取得を試みる */
        const pk = CONFIG.STRIPE_PUBLISHABLE_KEY
          || document.querySelector('meta[name="stripe-key"]')?.content;
        if (!pk) throw new Error('Stripe公開鍵が取得できませんでした');
        keyData.publishableKey = pk;
      }

      const stripe = (typeof Stripe !== 'undefined') ? Stripe(keyData.publishableKey) : null;
      if (!stripe) throw new Error('Stripe.jsが読み込まれていません');

      /* Embedded Checkout モーダルを作成 */
      const modal = document.createElement('div');
      modal.id = 'nuriel-checkout-modal';
      modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;';
      modal.innerHTML = `
        <div style="background:#fff;border-radius:12px;width:100%;max-width:500px;max-height:90vh;overflow:auto;position:relative;">
          <button id="nuriel-checkout-close" style="position:absolute;top:12px;right:12px;background:none;border:none;font-size:24px;cursor:pointer;color:#666;z-index:1;">&times;</button>
          <div id="nuriel-checkout-container" style="padding:16px;"></div>
        </div>
      `;
      document.body.appendChild(modal);

      document.getElementById('nuriel-checkout-close').addEventListener('click', closeNurielCheckoutModal);
      modal.addEventListener('click', (e) => { if (e.target === modal) closeNurielCheckoutModal(); });

      /* Embedded Checkoutをマウント */
      const checkout = await stripe.initEmbeddedCheckout({ clientSecret: result.clientSecret });
      window._nuriel_embedded_checkout = checkout;
      checkout.mount('#nuriel-checkout-container');
    } else {
      showToast('決済セッションの作成に失敗しました', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (btn) {
      btn.textContent = originalBtnText;
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  }
}

/** 退会処理（パスワード確認後にアカウント削除） */
async function handleWithdraw() {
  const pw = prompt('退会するにはパスワードを入力してください。\nこの操作は取り消せません。すべてのデータが削除されます。');
  if (!pw) return;
  if (!confirm('本当に退会しますか？\nすべてのデータが完全に削除されます。')) return;

  try {
    await api.request('/auth/account', {
      method: 'DELETE',
      body: JSON.stringify({ password: pw }),
    });
    localStorage.removeItem('nuriel_token');
    localStorage.removeItem('nuriel_user');
    showToast('退会処理が完了しました。ご利用ありがとうございました。');
    setTimeout(() => { window.location.href = '/'; }, 1500);
  } catch (err) {
    showToast(err.message || '退会処理に失敗しました', 'error');
  }
}

/** ログイン後のアプリデータ初期化 */
async function initAppData() {
  /* Checkout成功後のリダイレクト処理 */
  const urlParams = new URLSearchParams(window.location.search || window.location.hash.split('?')[1] || '');
  if (urlParams.get('session_id') || urlParams.get('mock_checkout') === 'success') {
    showToast('プランの登録が完了しました！', 'success');
    /* URLパラメータをクリーン */
    history.replaceState(null, '', '/app.html#plan');
  }

  try {
    const data = await api.get('/billing/status');
    if (data.plan && data.usage) {
      state.plan = {
        name: data.plan.name,
        remaining: data.usage.remaining,
        total: data.usage.monthly_limit,
      };
    }
  } catch {
    state.plan = { name: 'おためし', remaining: 3, total: 3 };
  }
  ui.updateRemaining();

  // ロックスタイルの更新
  updateStyleLocks();
}

/** プランに応じてスタイルのロック状態を更新 */
function updateStyleLocks() {
  const premiumStyles = document.querySelectorAll('.style-option[data-premium="true"]');
  premiumStyles.forEach((el) => {
    if (state.plan.name === 'たっぷり') {
      el.classList.remove('locked');
      el.setAttribute('aria-disabled', 'false');
    } else {
      el.classList.add('locked');
      el.setAttribute('aria-disabled', 'true');
    }
  });
}

/* ==============================================
   Service Worker 登録
   ============================================== */
async function registerSW() {
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
      reg.update();
    } catch (err) {
      console.warn('Service Worker 登録失敗:', err);
    }
  }
}

/* ==============================================
   初期化
   ============================================== */
async function init() {
  // Service Worker
  registerSW();

  // オフライン検知・通知バー
  initOfflineDetection();

  // キーボード操作ハンドラ（Escでモーダル閉じ等）
  initKeyboardHandlers();

  // イベントバインド
  bindEvents();
  uploader.init();
  initStyleSelector();
  initRouter();

  // Stripe & 決済方法検出を初期化
  initStripePaymentRequest();

  // 認証チェック
  if (auth.isLoggedIn()) {
    const valid = await auth.verify();
    if (valid) {
      state.user = auth.getUser();
      ui.hideAuth();
      hidePageLoader();
      initAppData();
      return;
    }
  }

  // 未ログイン → 認証画面表示
  ui.showAuth('login');

  // ページローダーを非表示
  hidePageLoader();
}

// セッションタイムアウト（24時間操作なしでログアウト）
(function() {
  const TIMEOUT = 24 * 60 * 60 * 1000;
  function resetTimer() { localStorage.setItem('nuriel_last_activity', Date.now()); }
  function checkTimeout() {
    const last = parseInt(localStorage.getItem('nuriel_last_activity') || '0', 10);
    if (last && Date.now() - last > TIMEOUT && localStorage.getItem('nuriel_token')) {
      localStorage.removeItem('nuriel_token');
      localStorage.removeItem('nuriel_user');
      alert('長時間操作がなかったため、セキュリティのためログアウトしました。');
      window.location.reload();
    }
  }
  checkTimeout();
  resetTimer();
  ['click', 'keydown', 'scroll', 'touchstart'].forEach(e => {
    document.addEventListener(e, resetTimer, { passive: true });
  });
})();

// DOM 準備完了後に初期化
document.addEventListener('DOMContentLoaded', init);
