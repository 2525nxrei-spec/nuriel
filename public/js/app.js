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
  ACCEPTED_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'],
  // 最大ファイルサイズ（10MB）
  MAX_FILE_SIZE: 10 * 1024 * 1024,
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
      if (err.name === 'TypeError' && err.message.includes('fetch')) {
        throw new Error('ネットワークに接続できません。通信環境をご確認ください。');
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

    if (mode === 'login') {
      title.textContent = 'ログイン';
      submitBtn.textContent = 'ログイン';
      switchText.innerHTML = 'アカウントをお持ちでない方は <a id="authToggle">新規登録はこちら</a>';
    } else {
      title.textContent = '新規登録';
      submitBtn.textContent = '無料で始める';
      switchText.innerHTML = 'アカウントをお持ちの方は <a id="authToggle">ログインはこちら</a>';
    }

    // 切替リンクにイベント
    document.getElementById('authToggle').addEventListener('click', () => {
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

    // ナビのアクティブ状態更新
    document.querySelectorAll('.nav-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.screen === screen);
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
    changeBtn.addEventListener('click', () => {
      fileInput.value = '';
      state.selectedFile = null;
      preview.classList.remove('show');
      area.style.display = 'block';
    });
  },

  /** ファイルを検証してプレビュー表示 */
  _handleFile(file) {
    // 形式チェック
    if (!CONFIG.ACCEPTED_TYPES.includes(file.type)) {
      showToast('JPEG / PNG / WebP 形式の画像を選んでください', 'error');
      return;
    }
    // サイズチェック
    if (file.size > CONFIG.MAX_FILE_SIZE) {
      showToast('ファイルサイズは10MB以下にしてください', 'error');
      return;
    }

    state.selectedFile = file;

    // プレビュー表示
    const reader = new FileReader();
    reader.onload = (e) => {
      document.getElementById('previewImg').src = e.target.result;
      document.getElementById('previewName').textContent = file.name;
      document.getElementById('previewContainer').classList.add('show');
      document.getElementById('uploadArea').style.display = 'none';
    };
    reader.readAsDataURL(file);
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
      options.forEach((o) => o.classList.remove('selected'));
      opt.classList.add('selected');
      state.selectedStyle = opt.dataset.style;
    });
  });
}

/* ==============================================
   線画変換モジュール
   ============================================== */
const converter = {
  /** 変換リクエストを送信し、ポーリングで完了を待つ */
  async generate() {
    if (!state.selectedFile) {
      showToast('写真を選んでください', 'error');
      return;
    }
    if (state.plan.remaining <= 0) {
      showToast('今月の変換枚数を使い切りました', 'error');
      return;
    }

    const overlay = document.getElementById('convertingOverlay');
    const progressFill = document.getElementById('progressFill');
    const convertingText = document.getElementById('convertingText');

    // 変換中オーバーレイ表示
    overlay.classList.add('show');
    progressFill.style.width = '0%';

    const messages = [
      '線画をつくっています...',
      'ペットの輪郭を抽出中...',
      '細部を仕上げています...',
      'もう少しで完成です...',
    ];

    try {
      // ① 画像アップロード
      const formData = new FormData();
      formData.append('image', state.selectedFile);

      const uploadResult = await api.post('/upload', formData);
      const imageKey = uploadResult.imageKey;

      // ② 線画変換リクエスト送信
      const convertResult = await api.post('/convert', {
        imageKey,
        style: state.selectedStyle,
      });
      const generationId = convertResult.generationId;

      // ③ ポーリングでステータス確認
      let retries = 0;
      const poll = async () => {
        if (retries >= CONFIG.POLL_MAX_RETRIES) {
          throw new Error('変換がタイムアウトしました。もう一度お試しください。');
        }

        const progress = Math.min(10 + retries * 3, 95);
        progressFill.style.width = `${progress}%`;
        convertingText.textContent = messages[Math.min(Math.floor(retries / 5), messages.length - 1)];

        const result = await api.get(`/convert/${generationId}/status`);

        if (result.status === 'completed') {
          progressFill.style.width = '100%';
          // 完了後、結果（lineArtBase64含む）を取得
          const fullResult = await api.get(`/convert/${generationId}/result`);
          return fullResult;
        }
        if (result.status === 'failed') {
          throw new Error(result.error || '変換に失敗しました。');
        }

        retries++;
        return new Promise((resolve) => setTimeout(() => resolve(poll()), CONFIG.POLL_INTERVAL));
      };

      const result = await poll();

      // ③ 結果表示
      overlay.classList.remove('show');
      this._showResult(result);

      // 残り回数を減らす
      state.plan.remaining = Math.max(0, state.plan.remaining - 1);
      ui.updateRemaining();

      showToast('塗り絵が完成しました！');

    } catch (err) {
      overlay.classList.remove('show');
      showToast(err.message, 'error');
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

    // PDFダウンロードボタン
    document.getElementById('btnDownloadPdf').onclick = () => {
      // 認証トークンをヘッダーで渡すため、fetchでダウンロード
      const token = localStorage.getItem('nuriel_token');
      fetch(`${CONFIG.API_BASE}/pdf/${genId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      })
        .then(res => {
          if (!res.ok) throw new Error('PDF取得に失敗しました');
          return res.blob();
        })
        .then(blob => {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `nuriel-${genId}.pdf`;
          a.click();
          URL.revokeObjectURL(url);
        })
        .catch(err => showToast(err.message, 'error'));
    };

    // ギャラリーに保存（変換完了時点で自動的にgenerationsに保存されるため、メッセージのみ）
    document.getElementById('btnSaveGallery').onclick = () => {
      showToast('ギャラリーに保存済みです');
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

    document.getElementById('modalBtnDownload').onclick = () => {
      if (item.pdfUrl) {
        const token = localStorage.getItem('nuriel_token');
        fetch(`${CONFIG.API_BASE}${item.pdfUrl}`, {
          headers: { 'Authorization': `Bearer ${token}` },
        })
          .then(res => {
            if (!res.ok) throw new Error('PDF取得に失敗しました');
            return res.blob();
          })
          .then(blob => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `nuriel-${item.id}.pdf`;
            a.click();
            URL.revokeObjectURL(url);
          })
          .catch(err => showToast(err.message, 'error'));
      } else {
        showToast('PDFがまだ生成されていません', 'error');
      }
    };

    // 削除
    document.getElementById('modalBtnDelete').onclick = async () => {
      if (!confirm('この塗り絵を削除しますか？')) return;
      try {
        await api.delete(`/gallery/${item.id}`);
        modal.classList.remove('show');
        showToast('削除しました');
        this.load();
      } catch (err) {
        showToast(err.message, 'error');
      }
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
      document.querySelectorAll('#appBillingToggle .billing-toggle-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
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

  // --- 設定: パスワード変更 ---
  document.getElementById('btnChangePassword').addEventListener('click', () => {
    showToast('パスワード変更メールを送信しました');
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

/** プラン変更処理（PayPay / Apple Pay / Google Pay / カード対応） */
async function handlePlanChange(planName) {
  if (state.plan.name === planName) return;

  /* ボタンをローディング状態にする */
  const btnId = planName === 'たっぷり' ? 'btnPlanTappuri' : 'btnPlanOtameshi';
  const btn = document.getElementById(btnId);
  if (btn) {
    btn.classList.add('loading');
    btn.disabled = true;
  }

  try {
    const planIdMap = { 'おためし': 'otameshi', 'たっぷり': 'tappuri' };
    const planId = planIdMap[planName];
    if (!planId) return;

    /* Stripe Checkout セッション作成
       バックエンドでPayPay / Apple Pay / Google Pay が自動的に有効化される */
    /* ユーザーが選択した請求期間を取得 */
    const activeToggle = document.querySelector('#appBillingToggle .billing-toggle-btn.active');
    const billingPeriod = activeToggle ? activeToggle.dataset.period : 'monthly';

    const result = await api.post('/billing/checkout', {
      plan_id: planId,
      billing_period: billingPeriod,
    });

    if (result.checkout_url) {
      /* Checkout画面へリダイレクト
         - カード決済: Checkout画面で入力
         - PayPay: Checkout画面からPayPayアプリへリダイレクト
         - Apple Pay: Safari上でCheckout画面にApple Payボタン表示
         - Google Pay: Chrome上でCheckout画面にGoogle Payボタン表示 */
      showToast('決済画面に移動します...');
      window.location.href = result.checkout_url;
    } else {
      /* モックモード: 即座にプラン切替 */
      state.plan.name = planName;
      state.plan.total = planName === 'たっぷり' ? 20 : 3;
      planUI.render();
      updateStyleLocks();
      showToast(`${planName}プランに変更しました`);
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (btn) {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  }
}

/** 退会処理（現時点では未実装のため、ログアウトのみ） */
async function handleWithdraw() {
  try {
    // TODO: 退会APIの実装後に /api/auth/withdraw を呼び出す
    await api.post('/auth/logout');
    auth.logout();
    showToast('退会処理を受け付けました。ご利用ありがとうございました。');
  } catch (err) {
    showToast(err.message, 'error');
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
    } else {
      el.classList.add('locked');
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
      initAppData();
      return;
    }
  }

  // 未ログイン → 認証画面表示
  ui.showAuth('login');
}

// DOM 準備完了後に初期化
document.addEventListener('DOMContentLoaded', init);
