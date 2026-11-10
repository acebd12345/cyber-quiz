'use strict';

(function () {
  const socket = io({
    reconnection: true,
    reconnectionAttempts: 30,
    reconnectionDelay: 1000
  });

  // 狀態儲存
  let playerToken = sessionStorage.getItem('cyberquiz_player_token') || null;
  let hostToken = sessionStorage.getItem('cyberquiz_host_token') || null;
  let currentHostPin = sessionStorage.getItem('cyberquiz_host_pin') || null;
  let currentDisplayPin = null;
  let isDisplayOnlyMode = false;
  let isProjectorSafeMode = false;

  let verifiedRoomPin = null;
  let pendingSelectedOption = null;
  let lastRenderedQuestionIndex = -999;

  let currentPublicState = null;
  let currentPersonalState = null;
  let currentHostState = null;
  let serverClockOffsetMs = 0;
  let countdownInterval = null;
  let knownServerBootId = null;
  let socketBootId = null;
  let playerSocketBound = false;

  function realignSocketToActiveServer(httpBootId) {
    if (!httpBootId) return;
    knownServerBootId = httpBootId;
    if (socketBootId && socketBootId !== httpBootId) {
      socketBootId = null;
      playerSocketBound = false;
      if (socket.connected) {
        socket.disconnect().connect();
      } else {
        socket.connect();
      }
    }
  }

  // 預設組別設定清單（Host 開房前編輯用）
  let draftGroups = [];
  let draftGroupsEdited = false;

  // Modal 無障礙焦點追蹤
  let activeModalEl = null;
  let modalReturnFocusEl = null;
  let confirmCallback = null;

  // DOM 參照
  const mainContent = document.getElementById('mainContent');
  const connStatusBadge = document.getElementById('connStatusBadge');
  const offlineBanner = document.getElementById('offlineBanner');
  const switchPlayerBtn = document.getElementById('switchPlayerBtn');
  const switchHostBtn = document.getElementById('switchHostBtn');
  const brandHomeBtn = document.getElementById('brandHomeBtn');

  const playerView = document.getElementById('playerView');
  const hostView = document.getElementById('hostView');

  // Player Join DOM
  const playerJoinCard = document.getElementById('playerJoinCard');
  const pinLookupForm = document.getElementById('pinLookupForm');
  const inputRoomPin = document.getElementById('inputRoomPin');
  const btnLookupPin = document.getElementById('btnLookupPin');
  const btnChangePin = document.getElementById('btnChangePin');
  const pinError = document.getElementById('pinError');

  const playerJoinForm = document.getElementById('playerJoinForm');
  const joinRoomTitle = document.getElementById('joinRoomTitle');
  const joinRoomCapacity = document.getElementById('joinRoomCapacity');
  const selectGroupCode = document.getElementById('selectGroupCode');
  const groupError = document.getElementById('groupError');
  const inputGroupPassword = document.getElementById('inputGroupPassword');
  const passwordError = document.getElementById('passwordError');
  const inputNickname = document.getElementById('inputNickname');
  const nicknameError = document.getElementById('nicknameError');
  const joinGeneralError = document.getElementById('joinGeneralError');
  const btnJoinRoom = document.getElementById('btnJoinRoom');
  const hostHeaderQrImg = document.getElementById('hostHeaderQrImg');
  const hostLobbyQrImg = document.getElementById('hostLobbyQrImg');
  const hostLobbyQrPinText = document.getElementById('hostLobbyQrPinText');
  const hostLobbyQrUrlText = document.getElementById('hostLobbyQrUrlText');

  // Player Game DOM
  const playerGameArea = document.getElementById('playerGameArea');
  const hudGroupBadge = document.getElementById('hudGroupBadge');
  const hudNickname = document.getElementById('hudNickname');
  const hudStreak = document.getElementById('hudStreak');
  const hudScore = document.getElementById('hudScore');
  const hudRank = document.getElementById('hudRank');
  const btnPlayerLeave = document.getElementById('btnPlayerLeave');

  const playerLobbyState = document.getElementById('playerLobbyState');
  const playerLobbyRoomTitle = document.getElementById('playerLobbyRoomTitle');
  const playerLobbyPin = document.getElementById('playerLobbyPin');
  const playerLobbyGroup = document.getElementById('playerLobbyGroup');
  const playerLobbyNickname = document.getElementById('playerLobbyNickname');
  const playerLobbyCount = document.getElementById('playerLobbyCount');

  const playerQuestionState = document.getElementById('playerQuestionState');
  const playerQProgress = document.getElementById('playerQProgress');
  const playerTimerPill = document.getElementById('playerTimerPill');
  const playerTimerSec = document.getElementById('playerTimerSec');
  const playerTimerBar = document.getElementById('playerTimerBar');
  const playerQTitle = document.getElementById('playerQTitle');
  const playerQScenario = document.getElementById('playerQScenario');
  const playerOptionsGrid = document.getElementById('playerOptionsGrid');
  const playerLockedBanner = document.getElementById('playerLockedBanner');
  const playerLockedTitle = document.getElementById('playerLockedTitle');
  const playerLockedMeta = document.getElementById('playerLockedMeta');
  const playerLockedNote = document.getElementById('playerLockedNote');

  const playerRevealState = document.getElementById('playerRevealState');
  const playerResultBanner = document.getElementById('playerResultBanner');
  const playerResultTitle = document.getElementById('playerResultTitle');
  const playerResultPoints = document.getElementById('playerResultPoints');
  const playerResultChoice = document.getElementById('playerResultChoice');
  const playerCorrectOptionBadge = document.getElementById('playerCorrectOptionBadge');
  const playerRevealQTitle = document.getElementById('playerRevealQTitle');
  const playerRevealScenario = document.getElementById('playerRevealScenario');
  const playerCorrectOptionText = document.getElementById('playerCorrectOptionText');
  const playerExplanationText = document.getElementById('playerExplanationText');

  const playerLeaderboardState = document.getElementById('playerLeaderboardState');
  const playerLbHeading = document.getElementById('playerLbHeading');
  const playerLbSubheading = document.getElementById('playerLbSubheading');
  const playerQuestionMvpBanner = document.getElementById('playerQuestionMvpBanner');
  const playerIndividualList = document.getElementById('playerIndividualList');
  const playerGroupList = document.getElementById('playerGroupList');
  const playerAllReviewCard = document.getElementById('playerAllReviewCard');
  const playerAllReviewList = document.getElementById('playerAllReviewList');

  // Host DOM
  const hostLoginCard = document.getElementById('hostLoginCard');
  const hostLoginForm = document.getElementById('hostLoginForm');
  const inputHostUsername = document.getElementById('inputHostUsername');
  const inputHostPassword = document.getElementById('inputHostPassword');
  const hostPasswordError = document.getElementById('hostPasswordError');
  const btnHostLoginSubmit = document.getElementById('btnHostLoginSubmit');

  const hostSetupCard = document.getElementById('hostSetupCard');
  const tabBtnRooms = document.getElementById('tabBtnRooms');
  const tabBtnQuestions = document.getElementById('tabBtnQuestions');
  const tabBtnAdmins = document.getElementById('tabBtnAdmins');
  const hostTabRooms = document.getElementById('hostTabRooms');
  const hostTabQuestions = document.getElementById('hostTabQuestions');
  const hostTabAdmins = document.getElementById('hostTabAdmins');
  const hostCurrentAdminLabel = document.getElementById('hostCurrentAdminLabel');
  const hostCurrentRoleBadge = document.getElementById('hostCurrentRoleBadge');
  const btnHostLogout = document.getElementById('btnHostLogout');

  const activeRoomsSection = document.getElementById('activeRoomsSection');
  const btnRefreshActiveRooms = document.getElementById('btnRefreshActiveRooms');
  const activeRoomsList = document.getElementById('activeRoomsList');

  const hostCreateRoomForm = document.getElementById('hostCreateRoomForm');
  const setupRoomTitle = document.getElementById('setupRoomTitle');
  const setupMaxPlayers = document.getElementById('setupMaxPlayers');
  const setupTimeLimit = document.getElementById('setupTimeLimit');
  const setupBgmMode = document.getElementById('setupBgmMode');
  const btnToggleBgm = document.getElementById('btnToggleBgm');
  const selectHostBgmTrack = document.getElementById('selectHostBgmTrack');
  const btnNextBgmTrack = document.getElementById('btnNextBgmTrack');
  const inputBgmVolume = document.getElementById('inputBgmVolume');
  const inputCustomBgmFile = document.getElementById('inputCustomBgmFile');
  const batchGroupCount = document.getElementById('batchGroupCount');
  const batchGroupMaxMembers = document.getElementById('batchGroupMaxMembers');
  const btnResizeGroups = document.getElementById('btnResizeGroups');
  const btnBatchGenerateGroups = document.getElementById('btnBatchGenerateGroups');
  const btnAddSingleGroup = document.getElementById('btnAddSingleGroup');
  const btnImportGroupsFile = document.getElementById('btnImportGroupsFile');
  const inputImportGroupsFile = document.getElementById('inputImportGroupsFile');
  const btnExportGroupsCsv = document.getElementById('btnExportGroupsCsv');
  const setupGroupsTbody = document.getElementById('setupGroupsTbody');
  const createRoomError = document.getElementById('createRoomError');
  const btnCreateRoomSubmit = document.getElementById('btnCreateRoomSubmit');
  const inputReconnectPin = document.getElementById('inputReconnectPin');
  const reconnectPinError = document.getElementById('reconnectPinError');
  const btnReconnectRoom = document.getElementById('btnReconnectRoom');

  // 題庫管理 DOM
  const questionsRoleNotice = document.getElementById('questionsRoleNotice');
  const btnExportQuestionsJson = document.getElementById('btnExportQuestionsJson');
  const btnImportQuestionsJson = document.getElementById('btnImportQuestionsJson');
  const inputImportQuestionsFile = document.getElementById('inputImportQuestionsFile');
  const btnResetDefaultQuestions = document.getElementById('btnResetDefaultQuestions');
  const btnOpenAddQuestion = document.getElementById('btnOpenAddQuestion');
  const questionsTableBody = document.getElementById('questionsTableBody');

  // 管理者與稽核日誌 DOM
  const btnOpenAddAdmin = document.getElementById('btnOpenAddAdmin');
  const adminsTableBody = document.getElementById('adminsTableBody');
  const btnRefreshAuditLogs = document.getElementById('btnRefreshAuditLogs');
  const auditLogsTableBody = document.getElementById('auditLogsTableBody');

  const hostActiveRoomArea = document.getElementById('hostActiveRoomArea');
  const hostPinDisplay = document.getElementById('hostPinDisplay');
  const hostRoomTitleDisplay = document.getElementById('hostRoomTitleDisplay');
  const displayModeBadge = document.getElementById('displayModeBadge');
  const hostPlayerCountPill = document.getElementById('hostPlayerCountPill');
  const hostQuestionCountPill = document.getElementById('hostQuestionCountPill');
  const hostStatusPill = document.getElementById('hostStatusPill');
  const hostActionButtons = document.getElementById('hostActionButtons');

  const btnToggleProjectorMode = document.getElementById('btnToggleProjectorMode');
  const btnOpenDisplayWindow = document.getElementById('btnOpenDisplayWindow');
  const btnTogglePasswordsModal = document.getElementById('btnTogglePasswordsModal');
  const btnSyncRoomQuestions = document.getElementById('btnSyncRoomQuestions');
  const btnHostNewRoom = document.getElementById('btnHostNewRoom');
  const btnHostDeleteRoom = document.getElementById('btnHostDeleteRoom');
  const btnHostNextQuestion = document.getElementById('btnHostNextQuestion');
  const btnHostRevealAnswer = document.getElementById('btnHostRevealAnswer');
  const btnHostShowLeaderboard = document.getElementById('btnHostShowLeaderboard');
  const btnHostFinishGame = document.getElementById('btnHostFinishGame');
  const btnHostSkipToNext = document.getElementById('btnHostSkipToNext');

  const hostLobbyPanel = document.getElementById('hostLobbyPanel');
  const hostGroupsStatusList = document.getElementById('hostGroupsStatusList');
  const hostKickHint = document.getElementById('hostKickHint');
  const hostPlayersGrid = document.getElementById('hostPlayersGrid');

  const hostQuestionPanel = document.getElementById('hostQuestionPanel');
  const hostQNumberBadge = document.getElementById('hostQNumberBadge');
  const hostAnsweredCounter = document.getElementById('hostAnsweredCounter');
  const hostTimerBox = document.getElementById('hostTimerBox');
  const hostTimerDisplay = document.getElementById('hostTimerDisplay');
  const hostTimerBar = document.getElementById('hostTimerBar');
  const hostQTitle = document.getElementById('hostQTitle');
  const hostQScenario = document.getElementById('hostQScenario');
  const hostExplanationBox = document.getElementById('hostExplanationBox');
  const hostCorrectAnswerPill = document.getElementById('hostCorrectAnswerPill');
  const hostExplanationText = document.getElementById('hostExplanationText');
  const hostRevealMvpLine = document.getElementById('hostRevealMvpLine');

  const hostLeaderboardPanel = document.getElementById('hostLeaderboardPanel');
  const hostPodiumSection = document.getElementById('hostPodiumSection');
  const hostPodiumContainer = document.getElementById('hostPodiumContainer');
  const hostQuestionMvpBanner = document.getElementById('hostQuestionMvpBanner');
  const hostIndividualLeaderboard = document.getElementById('hostIndividualLeaderboard');
  const hostGroupLeaderboard = document.getElementById('hostGroupLeaderboard');
  const hostAllQuestionsMvpCard = document.getElementById('hostAllQuestionsMvpCard');
  const hostAllQuestionsMvpList = document.getElementById('hostAllQuestionsMvpList');
  const btnExportCsv = document.getElementById('btnExportCsv');
  const btnFinishedNewRoom = document.getElementById('btnFinishedNewRoom');

  // Modals DOM
  const passwordsModal = document.getElementById('passwordsModal');
  const btnClosePasswordsModal = document.getElementById('btnClosePasswordsModal');
  const btnCopyAllPasswords = document.getElementById('btnCopyAllPasswords');
  const modalPasswordsList = document.getElementById('modalPasswordsList');

  const confirmModal = document.getElementById('confirmModal');
  const confirmModalTitle = document.getElementById('confirmModalTitle');
  const confirmModalMessage = document.getElementById('confirmModalMessage');
  const btnConfirmCloseX = document.getElementById('btnConfirmCloseX');
  const btnConfirmCancel = document.getElementById('btnConfirmCancel');
  const btnConfirmProceed = document.getElementById('btnConfirmProceed');

  const questionEditorModal = document.getElementById('questionEditorModal');
  const questionEditorModalTitle = document.getElementById('questionEditorModalTitle');
  const btnCloseQuestionModal = document.getElementById('btnCloseQuestionModal');
  const questionEditorForm = document.getElementById('questionEditorForm');
  const editQuestionId = document.getElementById('editQuestionId');
  const editQuestionVersion = document.getElementById('editQuestionVersion');
  const inputQuestionTitle = document.getElementById('inputQuestionTitle');
  const inputQuestionScenario = document.getElementById('inputQuestionScenario');
  const inputQuestionOptA = document.getElementById('inputQuestionOptA');
  const inputQuestionOptB = document.getElementById('inputQuestionOptB');
  const inputQuestionOptC = document.getElementById('inputQuestionOptC');
  const inputQuestionOptD = document.getElementById('inputQuestionOptD');
  const selectQuestionAnswer = document.getElementById('selectQuestionAnswer');
  const selectQuestionEnabled = document.getElementById('selectQuestionEnabled');
  const inputQuestionExplanation = document.getElementById('inputQuestionExplanation');
  const questionEditorError = document.getElementById('questionEditorError');
  const btnCancelQuestionModal = document.getElementById('btnCancelQuestionModal');
  const btnSaveQuestionSubmit = document.getElementById('btnSaveQuestionSubmit');

  const adminEditorModal = document.getElementById('adminEditorModal');
  const adminEditorModalTitle = document.getElementById('adminEditorModalTitle');
  const btnCloseAdminModal = document.getElementById('btnCloseAdminModal');
  const adminEditorForm = document.getElementById('adminEditorForm');
  const editAdminId = document.getElementById('editAdminId');
  const inputAdminUsername = document.getElementById('inputAdminUsername');
  const inputAdminDisplayName = document.getElementById('inputAdminDisplayName');
  const selectAdminRole = document.getElementById('selectAdminRole');
  const labelAdminPassword = document.getElementById('labelAdminPassword');
  const inputAdminPassword = document.getElementById('inputAdminPassword');
  const adminEditorError = document.getElementById('adminEditorError');
  const btnCancelAdminModal = document.getElementById('btnCancelAdminModal');
  const btnSaveAdminSubmit = document.getElementById('btnSaveAdminSubmit');

  let currentAdminProfile = null;
  let cachedQuestionsBank = [];
  let cachedAdminsList = [];

  // ==================== 工具函式：Toast、表單錯誤、無障礙 Modal ====================

  function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 3200);
  }

  function setFieldError(inputEl, errorEl, message, shouldFocus = true) {
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.classList.remove('hidden');
    }
    if (inputEl) {
      inputEl.setAttribute('aria-invalid', 'true');
      if (shouldFocus) inputEl.focus();
    }
  }

  function clearFieldError(inputEl, errorEl) {
    if (errorEl) {
      errorEl.textContent = '';
      errorEl.classList.add('hidden');
    }
    if (inputEl) {
      inputEl.removeAttribute('aria-invalid');
    }
  }

  function clearAllJoinErrors() {
    clearFieldError(inputRoomPin, pinError);
    clearFieldError(selectGroupCode, groupError);
    clearFieldError(inputGroupPassword, passwordError);
    clearFieldError(inputNickname, nicknameError);
    clearFieldError(null, joinGeneralError);
  }

  function openModal(modalEl, triggerEl) {
    activeModalEl = modalEl;
    modalReturnFocusEl = triggerEl || document.activeElement;
    modalEl.classList.remove('hidden');
    if (mainContent) {
      mainContent.inert = true;
      mainContent.setAttribute('aria-hidden', 'true');
    }
    const focusables = modalEl.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusables.length > 0) {
      focusables[0].focus();
    }
  }

  function closeModal(modalEl) {
    if (!modalEl) return;
    modalEl.classList.add('hidden');
    if (mainContent) {
      mainContent.inert = false;
      mainContent.removeAttribute('aria-hidden');
    }
    if (activeModalEl === modalEl) {
      activeModalEl = null;
    }
    if (modalReturnFocusEl && typeof modalReturnFocusEl.focus === 'function') {
      modalReturnFocusEl.focus();
      modalReturnFocusEl = null;
    }
  }

  function openConfirmDialog({
    title,
    message,
    confirmText = '確認',
    isDestructive = false,
    triggerEl,
    onConfirm
  }) {
    confirmModalTitle.textContent = title || '確認操作';
    confirmModalMessage.textContent = message || '';
    btnConfirmProceed.textContent = confirmText;
    btnConfirmProceed.className = isDestructive ? 'btn btn-destructive' : 'btn btn-primary';
    confirmCallback = onConfirm;
    openModal(confirmModal, triggerEl);
  }

  function cancelConfirmModal() {
    confirmCallback = null;
    closeModal(confirmModal);
  }

  btnConfirmCancel.addEventListener('click', cancelConfirmModal);
  if (btnConfirmCloseX) {
    btnConfirmCloseX.addEventListener('click', cancelConfirmModal);
  }

  btnConfirmProceed.addEventListener('click', () => {
    const fn = confirmCallback;
    confirmCallback = null;
    closeModal(confirmModal);
    if (typeof fn === 'function') fn();
  });

  document.addEventListener('keydown', (e) => {
    if (activeModalEl) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (activeModalEl === confirmModal) confirmCallback = null;
        closeModal(activeModalEl);
        return;
      }
      if (e.key === 'Tab') {
        const focusables = Array.from(
          activeModalEl.querySelectorAll(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
      return;
    }

    // 參賽者作答畫面支援鍵盤 A/B/C/D 或 1/2/3/4 快速選答
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (
      !playerView.classList.contains('hidden') &&
      !playerQuestionState.classList.contains('hidden') &&
      currentPublicState?.status === 'QUESTION_OPEN'
    ) {
      const keyMap = {
        a: 'A',
        A: 'A',
        '1': 'A',
        b: 'B',
        B: 'B',
        '2': 'B',
        c: 'C',
        C: 'C',
        '3': 'C',
        d: 'D',
        D: 'D',
        '4': 'D'
      };
      const mapped = keyMap[e.key];
      if (mapped) {
        const targetBtn = playerOptionsGrid.querySelector(`.option-btn[data-option="${mapped}"]`);
        if (targetBtn && !targetBtn.disabled) {
          e.preventDefault();
          targetBtn.click();
        }
      }
    }
  });

  [passwordsModal, confirmModal, questionEditorModal, adminEditorModal].forEach((modalEl) => {
    if (!modalEl) return;
    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl) {
        if (modalEl === confirmModal) confirmCallback = null;
        closeModal(modalEl);
      }
    });
  });

  function randomReadablePassword(len = 6) {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
    let out = '';
    const arr = new Uint32Array(len);
    window.crypto.getRandomValues(arr);
    for (let i = 0; i < len; i++) {
      out += chars[arr[i] % chars.length];
    }
    return out;
  }

  const CHINESE_NUMS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  function formatGroupDefaultName(index1Based) {
    if (index1Based >= 1 && index1Based <= 10) {
      return `第${CHINESE_NUMS[index1Based]}組`;
    }
    return `第 ${index1Based} 組`;
  }

  // ==================== 視角切換與唯讀展示模式 ====================

  const modeSwitcherNav = document.querySelector('.mode-switcher');

  /**
   * 角色切換列僅在主持人後台（/host）或本瀏覽器已登入主持人時顯示；
   * 參賽者入口（/、/?pin=）與投影展示頁（/display）一律隱藏，避免誤觸與同 IP 亂試密碼觸發鎖定。
   */
  function updateModeSwitcherVisibility(mode) {
    if (!modeSwitcherNav) return;
    const visible = mode === 'host' || (mode === 'player' && Boolean(hostToken));
    modeSwitcherNav.classList.toggle('hidden', !visible);
  }

  function showMode(mode) {
    updateModeSwitcherVisibility(mode);
    if (mode === 'display') {
      isDisplayOnlyMode = true;
      playerView.classList.add('hidden');
      hostView.classList.remove('hidden');
      hostLoginCard.classList.add('hidden');
      hostSetupCard.classList.add('hidden');
      hostActiveRoomArea.classList.remove('hidden');
      hostActionButtons.classList.add('hidden');
      displayModeBadge.textContent = '展示模式';
      displayModeBadge.classList.remove('hidden');
      hostKickHint.classList.add('hidden');
      if (btnFinishedNewRoom) btnFinishedNewRoom.classList.add('hidden');
      if (btnExportCsv) btnExportCsv.classList.add('hidden');
      if (currentDisplayPin) {
        subscribeDisplayToRoom(currentDisplayPin);
      }
      return;
    }

    isDisplayOnlyMode = false;
    hostActionButtons.classList.remove('hidden');
    if (btnFinishedNewRoom) btnFinishedNewRoom.classList.remove('hidden');
    if (btnExportCsv) btnExportCsv.classList.remove('hidden');
    updateProjectorModeUI();

    if (mode === 'host') {
      playerView.classList.add('hidden');
      hostView.classList.remove('hidden');
      switchHostBtn.className = 'btn btn-primary btn-sm';
      switchPlayerBtn.className = 'btn btn-ghost btn-sm';
      initHostView();
    } else {
      stopBgmPlayback();
      hostView.classList.add('hidden');
      playerView.classList.remove('hidden');
      switchPlayerBtn.className = 'btn btn-primary btn-sm';
      switchHostBtn.className = 'btn btn-ghost btn-sm';
    }
  }

  switchPlayerBtn.addEventListener('click', () => {
    window.history.pushState({}, '', '/');
    showMode('player');
  });

  switchHostBtn.addEventListener('click', () => {
    window.history.pushState({}, '', '/host');
    showMode('host');
  });

  brandHomeBtn.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    window.history.pushState({}, '', '/');
    showMode('player');
  });

  inputRoomPin.addEventListener('input', () => clearFieldError(inputRoomPin, pinError));
  selectGroupCode.addEventListener('change', () => clearFieldError(selectGroupCode, groupError));
  inputGroupPassword.addEventListener('input', () =>
    clearFieldError(inputGroupPassword, passwordError)
  );
  inputNickname.addEventListener('input', () => clearFieldError(inputNickname, nicknameError));
  inputHostPassword.addEventListener('input', () =>
    clearFieldError(inputHostPassword, hostPasswordError)
  );
  if (inputReconnectPin) {
    inputReconnectPin.addEventListener('input', () =>
      clearFieldError(inputReconnectPin, reconnectPinError)
    );
  }

  // ==================== 參賽者流程 (PLAYER FLOW) ====================

  function unlockPinForChange() {
    verifiedRoomPin = null;
    inputRoomPin.readOnly = false;
    inputRoomPin.disabled = false;
    btnLookupPin.classList.remove('hidden');
    btnChangePin.classList.add('hidden');
    playerJoinForm.classList.add('hidden');
    selectGroupCode.textContent = '';
    inputGroupPassword.value = '';
    clearAllJoinErrors();
    inputRoomPin.focus();
  }

  btnChangePin.addEventListener('click', unlockPinForChange);

  async function lookupRoomByPin(pin, preselectGroupCode = null) {
    clearAllJoinErrors();
    const cleanPin = String(pin || '').trim();
    if (!/^\d{6}$/.test(cleanPin)) {
      setFieldError(inputRoomPin, pinError, '請輸入 6 位數房間 PIN。');
      return;
    }

    btnLookupPin.disabled = true;
    btnLookupPin.textContent = '正在查詢…';

    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(cleanPin)}`);
      realignSocketToActiveServer(res.headers.get('X-Server-Boot-Id'));
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setFieldError(inputRoomPin, pinError, data.error || '找不到此房間，請確認房間 PIN。');
        playerJoinForm.classList.add('hidden');
        return;
      }

      const room = data.room;
      verifiedRoomPin = room.pin;
      inputRoomPin.value = room.pin;
      inputRoomPin.readOnly = true;
      btnLookupPin.classList.add('hidden');
      btnChangePin.classList.remove('hidden');

      joinRoomTitle.textContent = room.title;
      joinRoomCapacity.textContent = `${room.currentPlayers}／${room.maxPlayers} 人`;

      selectGroupCode.textContent = '';
      const placeholderOpt = document.createElement('option');
      placeholderOpt.value = '';
      placeholderOpt.disabled = true;
      placeholderOpt.selected = true;
      placeholderOpt.textContent = '請選擇組別';
      selectGroupCode.appendChild(placeholderOpt);

      let availableGroupsCount = 0;
      room.groups.forEach((g) => {
        if (!g.isFull) availableGroupsCount++;
        const opt = document.createElement('option');
        opt.value = g.code;
        opt.disabled = g.isFull;
        opt.textContent = `${g.name}　${g.currentMembers}／${g.maxMembers} 人${
          g.isFull ? '（已額滿）' : ''
        }`;
        if (preselectGroupCode && g.code === preselectGroupCode && !g.isFull) {
          placeholderOpt.selected = false;
          opt.selected = true;
        }
        selectGroupCode.appendChild(opt);
      });

      playerJoinForm.classList.remove('hidden');

      if (room.isRoomFull || availableGroupsCount === 0) {
        btnJoinRoom.disabled = true;
        setFieldError(
          null,
          joinGeneralError,
          '目前所有組別均已額滿，請聯絡主持人。',
          false
        );
      } else {
        btnJoinRoom.disabled = false;
        if (selectGroupCode.value) {
          inputGroupPassword.focus();
        } else {
          selectGroupCode.focus();
        }
      }
    } catch {
      setFieldError(inputRoomPin, pinError, '無法連線至伺服器，請稍後再試。');
    } finally {
      btnLookupPin.disabled = false;
      btnLookupPin.textContent = '繼續';
    }
  }

  pinLookupForm.addEventListener('submit', (e) => {
    e.preventDefault();
    lookupRoomByPin(inputRoomPin.value);
  });

  playerJoinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAllJoinErrors();

    const pin = verifiedRoomPin;
    if (!pin) {
      setFieldError(inputRoomPin, pinError, '請先輸入房間 PIN 並點擊繼續。');
      return;
    }

    const groupCode = selectGroupCode.value;
    const groupPassword = inputGroupPassword.value;
    const nickname = inputNickname.value.trim();

    if (!groupCode) {
      setFieldError(selectGroupCode, groupError, '請選擇組別。');
      return;
    }
    if (!groupPassword) {
      setFieldError(inputGroupPassword, passwordError, '請輸入組別密碼。');
      return;
    }
    if (!nickname) {
      setFieldError(inputNickname, nicknameError, '請輸入暱稱。');
      return;
    }

    btnJoinRoom.disabled = true;
    btnJoinRoom.textContent = '正在加入…';

    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(pin)}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupCode, groupPassword, nickname })
      });
      realignSocketToActiveServer(res.headers.get('X-Server-Boot-Id'));
      const data = await res.json();
      if (!res.ok || !data.ok) {
        const errMsg = data.error || '加入測驗失敗';
        if (errMsg.includes('密碼')) {
          setFieldError(inputGroupPassword, passwordError, errMsg);
        } else if (errMsg.includes('暱稱')) {
          setFieldError(inputNickname, nicknameError, errMsg);
        } else if (errMsg.includes('組')) {
          setFieldError(selectGroupCode, groupError, errMsg);
        } else {
          setFieldError(null, joinGeneralError, errMsg, false);
        }
        return;
      }

      playerToken = data.playerToken;
      playerSocketBound = false;
      sessionStorage.setItem('cyberquiz_player_token', playerToken);
      currentPublicState = data.gameState;
      currentPersonalState = data.player;
      pendingSelectedOption = null;
      lastRenderedQuestionIndex = -999;
      if (data.gameState?.serverNowEpoch) {
        serverClockOffsetMs = data.gameState.serverNowEpoch - Date.now();
      }

      bindPlayerSocket();
      renderPlayerScreen();
    } catch {
      setFieldError(null, joinGeneralError, '網路連線異常，請確認網路狀態後重試。', false);
    } finally {
      btnJoinRoom.disabled = false;
      btnJoinRoom.textContent = '加入測驗';
    }
  });

  function bindPlayerSocket() {
    if (!playerToken) return;
    if (!socket.connected) {
      socket.connect();
    }
    socket.emit('player:bind', { playerToken }, (ack) => {
      if (!ack || !ack.ok) {
        playerSocketBound = false;
        sessionStorage.removeItem('cyberquiz_player_token');
        playerToken = null;
        pendingSelectedOption = null;
        lastRenderedQuestionIndex = -999;
        playerGameArea.classList.add('hidden');
        playerJoinCard.classList.remove('hidden');
        if (ack?.error) {
          setFieldError(null, joinGeneralError, ack.error, false);
        }
        return;
      }
      playerSocketBound = true;
      currentPublicState = ack.gameState;
      currentPersonalState = ack.personal;
      if (ack.gameState?.serverNowEpoch) {
        serverClockOffsetMs = ack.gameState.serverNowEpoch - Date.now();
      }
      renderPlayerScreen();
    });
  }

  btnPlayerLeave.addEventListener('click', () => {
    openConfirmDialog({
      title: '離開測驗',
      message: '確定要離開目前的測驗房間嗎？離開後將釋放您的組別名額。',
      confirmText: '離開測驗',
      isDestructive: true,
      triggerEl: btnPlayerLeave,
      onConfirm: () => {
        const tokenToLeave = playerToken;
        if (tokenToLeave && socket.connected) {
          socket.emit('player:leave', { playerToken: tokenToLeave });
        }
        sessionStorage.removeItem('cyberquiz_player_token');
        playerToken = null;
        currentPublicState = null;
        currentPersonalState = null;
        pendingSelectedOption = null;
        lastRenderedQuestionIndex = -999;
        playerGameArea.classList.add('hidden');
        playerJoinCard.classList.remove('hidden');
        unlockPinForChange();
      }
    });
  });

  /**
   * 個人狀態是否與目前公開狀態屬於同一題、同一階段。
   * game:state 與 player:personal 是兩個獨立事件，抵達順序不保證；
   * 若直接使用上一題的 currentQuestionResult，會把新題目誤判為「已作答」而鎖死選項。
   */
  function isPersonalStateSynced() {
    if (!currentPersonalState || !currentPublicState) return false;
    if (typeof currentPersonalState.questionIndex !== 'number') return true; // 舊版伺服器相容
    return (
      currentPersonalState.questionIndex === currentPublicState.currentQuestionIndex &&
      currentPersonalState.roomStatus === currentPublicState.status
    );
  }

  function getSyncedQuestionResult() {
    return isPersonalStateSynced() ? currentPersonalState.currentQuestionResult : null;
  }

  function hasSubmittedCurrentQuestion() {
    const r = getSyncedQuestionResult();
    return Boolean(pendingSelectedOption || (r && r.submitted));
  }

  async function submitPlayerAnswerHttp(option, answeringIndex) {
    try {
      const res = await fetch('/api/player/answer', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${playerToken}`
        },
        body: JSON.stringify({ option })
      });
      realignSocketToActiveServer(res.headers.get('X-Server-Boot-Id'));
      const data = await res.json();
      if (
        currentPublicState?.currentQuestionIndex !== answeringIndex ||
        currentPublicState?.status !== 'QUESTION_OPEN'
      ) {
        return;
      }
      if (!res.ok || !data.ok) {
        pendingSelectedOption = null;
        renderOptionButtonsLockState(
          null,
          null,
          false,
          data?.error || '送出答案失敗，請重新選擇答案。'
        );
        return;
      }
      if (data.personal) {
        currentPersonalState = data.personal;
      }
      renderOptionButtonsLockState(data.acceptedOption, data.elapsedMs, false, null);
    } catch {
      if (
        currentPublicState?.currentQuestionIndex === answeringIndex &&
        currentPublicState?.status === 'QUESTION_OPEN'
      ) {
        pendingSelectedOption = null;
        renderOptionButtonsLockState(null, null, false, '網路異常，請重新點擊答案送出。');
      }
    }
  }

  // 參賽者點擊 A/B/C/D 選項按鈕（點擊後立即進入送出狀態並停用四個選項）
  playerOptionsGrid.querySelectorAll('.option-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const option = btn.getAttribute('data-option');
      if (!playerToken || !option) return;
      if (currentPublicState?.status !== 'QUESTION_OPEN') return;
      if (hasSubmittedCurrentQuestion()) return;

      const answeringIndex = currentPublicState.currentQuestionIndex;
      pendingSelectedOption = option;
      renderOptionButtonsLockState(option, null, true, null);

      if (!socket.connected || !playerSocketBound) {
        submitPlayerAnswerHttp(option, answeringIndex);
        return;
      }

      socket.emit('player:answer', { playerToken, option }, (ack) => {
        // 若回應抵達時已換題或已揭曉，忽略此回應，避免影響新題目
        if (
          currentPublicState?.currentQuestionIndex !== answeringIndex ||
          currentPublicState?.status !== 'QUESTION_OPEN'
        ) {
          return;
        }
        if (!ack || !ack.ok) {
          submitPlayerAnswerHttp(option, answeringIndex);
          return;
        }
        renderOptionButtonsLockState(ack.acceptedOption, ack.elapsedMs, false, null);
      });
    });
  });

  function renderOptionButtonsLockState(selectedOpt, elapsedMs, isSubmitting, errorMsg) {
    const buttons = playerOptionsGrid.querySelectorAll('.option-btn');
    if (errorMsg) {
      buttons.forEach((btn) => {
        btn.disabled = false;
        btn.classList.remove('selected-choice', 'dimmed-choice');
      });
      playerLockedBanner.classList.remove('hidden');
      playerLockedTitle.textContent = '送出失敗';
      playerLockedMeta.textContent = '';
      if (playerLockedNote) {
        playerLockedNote.textContent = errorMsg;
      }
      return;
    }

    buttons.forEach((btn) => {
      btn.disabled = true;
      const opt = btn.getAttribute('data-option');
      btn.classList.toggle('selected-choice', opt === selectedOpt);
      btn.classList.toggle('dimmed-choice', opt !== selectedOpt);
    });
    playerLockedBanner.classList.remove('hidden');
    if (isSubmitting) {
      playerLockedTitle.textContent = '正在送出答案';
      playerLockedMeta.textContent = `已選擇 ${selectedOpt}`;
      if (playerLockedNote) {
        playerLockedNote.textContent = '正在傳送作答紀錄…';
      }
    } else {
      playerLockedTitle.textContent = '答案已送出';
      playerLockedMeta.textContent =
        typeof elapsedMs === 'number'
          ? `選擇 ${selectedOpt}（${(elapsedMs / 1000).toFixed(2)} 秒）`
          : `選擇 ${selectedOpt}`;
      if (playerLockedNote) {
        playerLockedNote.textContent = '答案已送出，截止後公布結果。';
      }
    }
  }

  function renderPlayerScreen() {
    if (!playerToken || !currentPublicState || !currentPersonalState) {
      playerJoinCard.classList.remove('hidden');
      playerGameArea.classList.add('hidden');
      return;
    }

    playerJoinCard.classList.add('hidden');
    playerGameArea.classList.remove('hidden');

    if (currentPublicState.currentQuestionIndex !== lastRenderedQuestionIndex) {
      lastRenderedQuestionIndex = currentPublicState.currentQuestionIndex;
      pendingSelectedOption = null;
    }

    hudGroupBadge.textContent = currentPersonalState.groupName;
    hudNickname.textContent = currentPersonalState.nickname;
    hudScore.textContent = `${currentPersonalState.score.toLocaleString()} 分`;
    hudRank.textContent = currentPersonalState.rank
      ? `第 ${currentPersonalState.rank} 名`
      : '排名 -';
    hudStreak.textContent = `連續答對 ${currentPersonalState.streak || 0} 題`;

    playerLobbyState.classList.add('hidden');
    playerQuestionState.classList.add('hidden');
    playerRevealState.classList.add('hidden');
    playerLeaderboardState.classList.add('hidden');

    const status = currentPublicState.status;

    if (status === 'LOBBY') {
      playerLobbyState.classList.remove('hidden');
      if (playerLobbyRoomTitle) playerLobbyRoomTitle.textContent = currentPublicState.title;
      playerLobbyPin.textContent = currentPublicState.pin;
      if (playerLobbyGroup) playerLobbyGroup.textContent = currentPersonalState.groupName;
      if (playerLobbyNickname) playerLobbyNickname.textContent = currentPersonalState.nickname;
      playerLobbyCount.textContent = `${currentPublicState.currentPlayers}／${currentPublicState.maxPlayers} 人`;
    } else if (status === 'QUESTION_OPEN') {
      playerQuestionState.classList.remove('hidden');
      const q = currentPublicState.question;
      if (q) {
        playerQProgress.textContent = `第 ${q.number}／${q.total} 題`;
        playerQTitle.textContent = `${q.number}. ${q.title}`;
        playerQScenario.textContent = q.scenario;
        document.getElementById('playerOptTextA').textContent = q.options.A;
        document.getElementById('playerOptTextB').textContent = q.options.B;
        document.getElementById('playerOptTextC').textContent = q.options.C;
        document.getElementById('playerOptTextD').textContent = q.options.D;
      }

      const submittedInfo = getSyncedQuestionResult();
      if (submittedInfo && submittedInfo.submitted) {
        pendingSelectedOption = null;
        renderOptionButtonsLockState(
          submittedInfo.selectedOption,
          submittedInfo.elapsedMs,
          false,
          null
        );
      } else if (pendingSelectedOption) {
        renderOptionButtonsLockState(pendingSelectedOption, null, true, null);
      } else {
        const buttons = playerOptionsGrid.querySelectorAll('.option-btn');
        buttons.forEach((btn) => {
          btn.disabled = false;
          btn.classList.remove('selected-choice', 'dimmed-choice');
        });
        playerLockedBanner.classList.add('hidden');
      }
      startClientCountdown();
    } else if (status === 'QUESTION_REVEAL') {
      playerRevealState.classList.remove('hidden');
      const q = currentPublicState.question;
      const resInfo = getSyncedQuestionResult();

      if (!isPersonalStateSynced()) {
        // 個人結算尚未抵達（數毫秒內會補上），先顯示中性狀態，避免誤顯示「未作答／答錯」
        playerResultBanner.className = 'result-banner';
        playerResultTitle.textContent = '結算中…';
        playerResultPoints.textContent = '';
        playerResultChoice.textContent = `正確答案：${q ? q.answer : ''}`;
      } else if (resInfo && resInfo.submitted && resInfo.isCorrect) {
        playerResultBanner.className = 'result-banner is-correct';
        playerResultTitle.textContent = '答對';
        playerResultPoints.textContent = `+${resInfo.points.toLocaleString()} 分`;
        playerResultChoice.textContent = `你的選擇：${resInfo.selectedOption}（${(
          resInfo.elapsedMs / 1000
        ).toFixed(2)} 秒）`;
      } else if (resInfo && resInfo.submitted && !resInfo.isCorrect) {
        playerResultBanner.className = 'result-banner is-wrong';
        playerResultTitle.textContent = '答錯';
        playerResultPoints.textContent = '+0 分';
        playerResultChoice.textContent = `你的選擇：${resInfo.selectedOption}｜正確答案：${
          q ? q.answer : ''
        }`;
      } else {
        playerResultBanner.className = 'result-banner is-wrong';
        playerResultTitle.textContent = '本題未作答';
        playerResultPoints.textContent = '+0 分';
        playerResultChoice.textContent = `正確答案：${q ? q.answer : ''}`;
      }

      if (q) {
        playerCorrectOptionBadge.textContent = `正確答案：${q.answer}`;
        playerRevealQTitle.textContent = `${q.number}. ${q.title}`;
        playerRevealScenario.textContent = q.scenario;
        playerCorrectOptionText.textContent = `${q.answer}. ${q.options[q.answer] || ''}`;
        playerExplanationText.textContent = q.explanation || '';
      }
    } else if (status === 'LEADERBOARD' || status === 'FINISHED') {
      playerLeaderboardState.classList.remove('hidden');
      if (status === 'FINISHED') {
        playerLbHeading.textContent = '測驗已結束';
        playerLbSubheading.textContent = `你的最終名次：第 ${
          currentPersonalState.rank || '-'
        } 名｜總分 ${currentPersonalState.score.toLocaleString()} 分（答對 ${
          currentPersonalState.correctCount
        }／${currentPublicState.totalQuestions} 題）`;
        renderQuestionMvpBannerDom(playerQuestionMvpBanner, null);
      } else {
        playerLbHeading.textContent = `第 ${currentPublicState.currentQuestionIndex + 1} 題後排行榜`;
        playerLbSubheading.textContent = `你的目前名次：第 ${
          currentPersonalState.rank || '-'
        } 名｜總分 ${currentPersonalState.score.toLocaleString()} 分`;
        renderQuestionMvpBannerDom(playerQuestionMvpBanner, currentPublicState.currentQuestionMvp);
      }

      renderIndividualLeaderboardDom(
        playerIndividualList,
        currentPublicState.leaderboard.slice(0, 10),
        false,
        currentPersonalState.id,
        status === 'LEADERBOARD'
      );
      renderGroupLeaderboardDom(playerGroupList, currentPublicState.groupLeaderboard);

      if (status === 'FINISHED' && Array.isArray(currentPublicState.allQuestionsReview)) {
        playerAllReviewCard.classList.remove('hidden');
        renderAllQuestionsReviewDom(playerAllReviewList, currentPublicState.allQuestionsReview);
      } else {
        playerAllReviewCard.classList.add('hidden');
      }
    }
  }

  // ==================== 主持人與展示模式流程 (HOST & DISPLAY FLOW) ====================

  async function subscribeDisplayToRoom(pin) {
    if (!pin) return;
    const cleanPin = String(pin).trim();
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(cleanPin)}/state`);
      realignSocketToActiveServer(res.headers.get('X-Server-Boot-Id'));
      const data = await res.json();
      if (res.ok && data.ok && data.gameState) {
        currentHostState = data.gameState;
        if (data.gameState.serverNowEpoch) {
          serverClockOffsetMs = data.gameState.serverNowEpoch - Date.now();
        }
        renderHostScreen();
      }
    } catch {
      // ignore initial HTTP fetch error
    }
    if (!socket.connected) {
      socket.connect();
    }
    socket.emit('display:subscribe', { pin: cleanPin }, (ack) => {
      if (!ack || !ack.ok) {
        if (!currentHostState) {
          showToast(ack?.error || '找不到此房間', 'error');
        }
        return;
      }
      currentHostState = ack.gameState;
      if (ack.gameState?.serverNowEpoch) {
        serverClockOffsetMs = ack.gameState.serverNowEpoch - Date.now();
      }
      renderHostScreen();
    });
  }

  function isSuperAdmin() {
    return currentAdminProfile?.adminRole === 'super_admin';
  }

  function handleHostUnauthorized(msg) {
    sessionStorage.removeItem('cyberquiz_host_token');
    sessionStorage.removeItem('cyberquiz_host_pin');
    hostToken = null;
    currentHostPin = null;
    currentAdminProfile = null;
    initHostView();
    if (msg) {
      setFieldError(inputHostPassword, hostPasswordError, msg);
    }
  }

  async function fetchHostApi(url, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    if (hostToken) {
      headers.Authorization = `Bearer ${hostToken}`;
    }
    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, Object.assign({}, options, { headers }));
    realignSocketToActiveServer(res.headers.get('X-Server-Boot-Id'));
    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    if (res.status === 401) {
      handleHostUnauthorized(data.error || '登入憑證已失效或已過期，請重新登入。');
      return { res, data, unauthorized: true };
    }
    return { res, data, unauthorized: false };
  }

  function updateAdminIdentityUI() {
    const username = currentAdminProfile?.username || 'admin';
    const displayName = currentAdminProfile?.displayName || '系統管理員';
    const superRole = isSuperAdmin();
    if (hostCurrentAdminLabel) {
      hostCurrentAdminLabel.textContent = `${displayName} (${username})`;
    }
    if (hostCurrentRoleBadge) {
      hostCurrentRoleBadge.textContent = superRole ? '最高管理員' : '一般主持人';
      hostCurrentRoleBadge.className = superRole ? 'badge badge-info' : 'badge';
    }
    if (tabBtnAdmins) {
      tabBtnAdmins.classList.toggle('hidden', !superRole);
    }
    if (btnImportQuestionsJson) {
      btnImportQuestionsJson.classList.toggle('hidden', !superRole);
    }
    if (btnResetDefaultQuestions) {
      btnResetDefaultQuestions.classList.toggle('hidden', !superRole);
    }
    if (btnOpenAddQuestion) {
      btnOpenAddQuestion.classList.toggle('hidden', !superRole);
    }
    if (questionsRoleNotice) {
      questionsRoleNotice.textContent = superRole
        ? '管理中央題庫；進行中的比賽房間已鎖定建立當下之題目快照，不受改題影響。'
        : '目前為一般主持人權限（唯讀檢視與匯出）；如需新增或修改題目請使用最高管理員帳號。';
    }
  }

  async function refreshAdminProfile() {
    if (!hostToken) return false;
    try {
      const { res, data, unauthorized } = await fetchHostApi('/api/host/me');
      if (unauthorized || !res.ok || !data.ok) return false;
      currentAdminProfile = data.admin;
      updateAdminIdentityUI();
      return true;
    } catch {
      return false;
    }
  }

  function switchAdminSubtab(tabName) {
    const tabs = [
      { key: 'rooms', btn: tabBtnRooms, panel: hostTabRooms },
      { key: 'questions', btn: tabBtnQuestions, panel: hostTabQuestions },
      { key: 'admins', btn: tabBtnAdmins, panel: hostTabAdmins }
    ];
    tabs.forEach(({ key, btn, panel }) => {
      const active = key === tabName;
      if (btn) {
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
        btn.className = active ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
        if (key === 'admins' && !isSuperAdmin()) {
          btn.classList.add('hidden');
        }
      }
      if (panel) {
        panel.classList.toggle('hidden', !active);
      }
    });

    if (tabName === 'rooms') {
      loadActiveRoomsList();
    } else if (tabName === 'questions') {
      loadQuestionsBank();
    } else if (tabName === 'admins' && isSuperAdmin()) {
      loadAdminsAndLogs();
    }
  }

  if (tabBtnRooms) tabBtnRooms.addEventListener('click', () => switchAdminSubtab('rooms'));
  if (tabBtnQuestions) {
    tabBtnQuestions.addEventListener('click', () => switchAdminSubtab('questions'));
  }
  if (tabBtnAdmins) tabBtnAdmins.addEventListener('click', () => switchAdminSubtab('admins'));

  if (btnHostLogout) {
    btnHostLogout.addEventListener('click', () => {
      handleHostUnauthorized();
      showToast('已登出後台', 'info');
    });
  }

  function updateProjectorModeUI() {
    if (isDisplayOnlyMode) return;
    btnToggleProjectorMode.classList.toggle('active-toggle', isProjectorSafeMode);
    btnToggleProjectorMode.textContent = isProjectorSafeMode ? '退出投影模式' : '投影模式';

    btnHostNewRoom.classList.toggle('hidden', isProjectorSafeMode);
    if (btnHostDeleteRoom) {
      btnHostDeleteRoom.classList.toggle('hidden', isProjectorSafeMode);
    }
    if (btnSyncRoomQuestions) {
      const showSync = !isProjectorSafeMode && currentHostState?.status === 'LOBBY';
      btnSyncRoomQuestions.classList.toggle('hidden', !showSync);
    }
    displayModeBadge.textContent = '投影模式';
    displayModeBadge.classList.toggle('hidden', !isProjectorSafeMode);
    hostKickHint.classList.toggle('hidden', isProjectorSafeMode);

    if (currentHostState) {
      renderHostScreen();
    }
  }

  btnToggleProjectorMode.addEventListener('click', () => {
    isProjectorSafeMode = !isProjectorSafeMode;
    if (isProjectorSafeMode && activeModalEl === passwordsModal) {
      closeModal(passwordsModal);
    }
    updateProjectorModeUI();
  });

  btnOpenDisplayWindow.addEventListener('click', () => {
    const pin = currentHostState?.pin || currentHostPin;
    if (!pin) return;
    window.open(`/display/${encodeURIComponent(pin)}`, '_blank', 'noopener');
  });

  async function initHostView() {
    if (!hostToken) {
      hostLoginCard.classList.remove('hidden');
      hostSetupCard.classList.add('hidden');
      hostActiveRoomArea.classList.add('hidden');
      return;
    }

    hostLoginCard.classList.add('hidden');
    const ok = await refreshAdminProfile();
    if (!ok && !hostToken) return;

    if (currentHostPin) {
      subscribeHostToRoom(currentHostPin);
    } else {
      openHostSetupScreen();
    }
  }

  function openHostSetupScreen() {
    hostSetupCard.classList.remove('hidden');
    hostActiveRoomArea.classList.add('hidden');
    clearFieldError(null, createRoomError);
    clearFieldError(inputReconnectPin, reconnectPinError);
    updateAdminIdentityUI();
    switchAdminSubtab('rooms');
    if (draftGroups.length === 0) {
      generateDraftGroups(
        parseInt(batchGroupCount.value, 10) || 6,
        parseInt(batchGroupMaxMembers.value, 10) || 5
      );
      draftGroupsEdited = false;
    } else {
      renderDraftGroupsTable();
    }
  }

  async function loadActiveRoomsList() {
    if (!hostToken || !activeRoomsSection || !activeRoomsList) return;
    try {
      const { res, data, unauthorized } = await fetchHostApi('/api/host/rooms');
      if (unauthorized || !res.ok || !data.ok) return;
      const rooms = data.rooms || [];
      if (rooms.length === 0) {
        activeRoomsSection.classList.add('hidden');
        activeRoomsList.textContent = '';
        return;
      }
      activeRoomsSection.classList.remove('hidden');
      activeRoomsList.textContent = '';

      const statusLabels = {
        LOBBY: '等待室',
        QUESTION_OPEN: '作答中',
        QUESTION_REVEAL: '答案揭曉',
        LEADERBOARD: '排行榜',
        FINISHED: '已結束'
      };

      rooms.forEach((r) => {
        const row = document.createElement('div');
        row.className = 'active-room-row';

        const meta = document.createElement('div');
        meta.className = 'active-room-meta';

        const pinBadge = document.createElement('span');
        pinBadge.className = 'badge badge-info mono-text';
        pinBadge.textContent = `PIN ${r.pin}`;

        const titleStrong = document.createElement('strong');
        titleStrong.textContent = r.title;

        const stBadge = document.createElement('span');
        stBadge.className = r.status === 'FINISHED' ? 'badge' : 'badge badge-success';
        stBadge.textContent = statusLabels[r.status] || r.status;

        const infoSpan = document.createElement('span');
        infoSpan.className = 'text-muted text-sm';
        infoSpan.textContent = `${r.currentPlayers}／${r.maxPlayers} 人｜${r.totalQuestions} 題｜建立者：${r.createdBy || 'admin'}`;

        meta.append(pinBadge, titleStrong, stBadge, infoSpan);

        const actionsWrap = document.createElement('div');
        actionsWrap.className = 'inline-form';

        const enterBtn = document.createElement('button');
        enterBtn.type = 'button';
        enterBtn.className = 'btn btn-primary btn-xs';
        enterBtn.textContent = '進入控場';
        enterBtn.addEventListener('click', () => {
          subscribeHostToRoom(r.pin);
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btn btn-destructive-outline btn-xs';
        deleteBtn.textContent = '刪除房間';
        deleteBtn.addEventListener('click', () => {
          confirmDeleteRoom(r.pin, r.title, r.currentPlayers, deleteBtn);
        });

        actionsWrap.append(enterBtn, deleteBtn);
        row.append(meta, actionsWrap);
        activeRoomsList.appendChild(row);
      });
    } catch {
      // ignore background list error
    }
  }

  function confirmDeleteRoom(pin, title, currentPlayers, triggerEl) {
    if (!pin || !hostToken) return;
    openConfirmDialog({
      title: '刪除房間',
      message: `確定要永久刪除房間「${title || pin}」（PIN：${pin}，目前 ${
        currentPlayers ?? 0
      } 人）嗎？刪除後所有參賽者將被移出，且作答紀錄無法復原。`,
      confirmText: '確定刪除',
      isDestructive: true,
      triggerEl,
      onConfirm: async () => {
        try {
          const { res, data, unauthorized } = await fetchHostApi(
            `/api/host/rooms/${encodeURIComponent(pin)}`,
            { method: 'DELETE' }
          );
          if (unauthorized) return;
          if (!res.ok || !data.ok) {
            showToast(data.error || '刪除房間失敗', 'error');
            return;
          }
          showToast(`已刪除房間 ${pin}`, 'success');
          if (currentHostPin === pin || currentHostState?.pin === pin) {
            currentHostPin = null;
            currentHostState = null;
            sessionStorage.removeItem('cyberquiz_host_pin');
            openHostSetupScreen();
          } else {
            loadActiveRoomsList();
          }
        } catch {
          showToast('刪除房間時發生網路錯誤', 'error');
        }
      }
    });
  }

  if (btnRefreshActiveRooms) {
    btnRefreshActiveRooms.addEventListener('click', loadActiveRoomsList);
  }

  function generateDraftGroups(count, maxMembers) {
    draftGroups = [];
    for (let i = 1; i <= count; i++) {
      draftGroups.push({
        code: `G${i}`,
        name: formatGroupDefaultName(i),
        password: randomReadablePassword(6),
        maxMembers
      });
    }
    draftGroupsEdited = false;
    renderDraftGroupsTable();
  }

  function resizeDraftGroupsPreservingEdits(targetCount, targetMaxMembers) {
    const currentLen = draftGroups.length;
    if (targetCount > currentLen) {
      for (let i = currentLen + 1; i <= targetCount; i++) {
        draftGroups.push({
          code: `G${i}`,
          name: formatGroupDefaultName(i),
          password: randomReadablePassword(6),
          maxMembers: targetMaxMembers
        });
      }
    } else if (targetCount < currentLen) {
      draftGroups.splice(targetCount);
    }
    draftGroups.forEach((g) => {
      g.maxMembers = targetMaxMembers;
    });
    renderDraftGroupsTable();
  }

  function renderDraftGroupsTable() {
    setupGroupsTbody.textContent = '';
    draftGroups.forEach((g, idx) => {
      const tr = document.createElement('tr');

      const tdCode = document.createElement('td');
      tdCode.className = 'mono-text';
      tdCode.textContent = `G${idx + 1}`;
      g.code = `G${idx + 1}`;

      const tdName = document.createElement('td');
      const inpName = document.createElement('input');
      inpName.type = 'text';
      inpName.className = 'input-sm';
      inpName.maxLength = 24;
      inpName.value = g.name;
      inpName.setAttribute('aria-label', `${g.code} 組別名稱`);
      inpName.addEventListener('input', () => {
        g.name = inpName.value;
        draftGroupsEdited = true;
      });
      tdName.appendChild(inpName);

      const tdPass = document.createElement('td');
      const inpPass = document.createElement('input');
      inpPass.type = 'text';
      inpPass.className = 'input-sm mono-input';
      inpPass.maxLength = 24;
      inpPass.value = g.password;
      inpPass.setAttribute('aria-label', `${g.code} 組別密碼`);
      inpPass.addEventListener('input', () => {
        g.password = inpPass.value;
        draftGroupsEdited = true;
      });
      tdPass.appendChild(inpPass);

      const tdMax = document.createElement('td');
      const inpMax = document.createElement('input');
      inpMax.type = 'number';
      inpMax.className = 'input-xs';
      inpMax.min = '1';
      inpMax.max = '200';
      inpMax.value = String(g.maxMembers);
      inpMax.setAttribute('aria-label', `${g.code} 人數上限`);
      inpMax.addEventListener('input', () => {
        g.maxMembers = Math.max(1, parseInt(inpMax.value, 10) || 1);
        draftGroupsEdited = true;
      });
      tdMax.appendChild(inpMax);

      const tdAct = document.createElement('td');
      const btnDel = document.createElement('button');
      btnDel.type = 'button';
      btnDel.className = 'btn btn-destructive-outline btn-xs';
      btnDel.textContent = '刪除組別';
      btnDel.disabled = draftGroups.length <= 1;
      btnDel.addEventListener('click', () => {
        if (draftGroups.length <= 1) return;
        draftGroups.splice(idx, 1);
        batchGroupCount.value = String(draftGroups.length);
        draftGroupsEdited = true;
        renderDraftGroupsTable();
      });
      tdAct.appendChild(btnDel);

      tr.append(tdCode, tdName, tdPass, tdMax, tdAct);
      setupGroupsTbody.appendChild(tr);
    });
  }

  btnResizeGroups.addEventListener('click', () => {
    const count = Math.max(1, Math.min(50, parseInt(batchGroupCount.value, 10) || 6));
    const maxM = Math.max(1, Math.min(100, parseInt(batchGroupMaxMembers.value, 10) || 5));
    if (draftGroupsEdited && count < draftGroups.length) {
      openConfirmDialog({
        title: '調整組數',
        message: '減少組數會移除後方的組別設定，是否繼續？',
        confirmText: '繼續調整',
        isDestructive: true,
        triggerEl: btnResizeGroups,
        onConfirm: () => {
          resizeDraftGroupsPreservingEdits(count, maxM);
        }
      });
    } else {
      resizeDraftGroupsPreservingEdits(count, maxM);
    }
  });

  btnBatchGenerateGroups.addEventListener('click', () => {
    const count = Math.max(1, Math.min(50, parseInt(batchGroupCount.value, 10) || 6));
    const maxM = Math.max(1, Math.min(100, parseInt(batchGroupMaxMembers.value, 10) || 5));

    if (draftGroupsEdited) {
      openConfirmDialog({
        title: '重新產生組別',
        message: '重新產生會取代目前的組別設定，是否繼續？',
        confirmText: '重新產生',
        isDestructive: true,
        triggerEl: btnBatchGenerateGroups,
        onConfirm: () => {
          generateDraftGroups(count, maxM);
        }
      });
    } else {
      generateDraftGroups(count, maxM);
    }
  });

  btnAddSingleGroup.addEventListener('click', () => {
    const nextNum = draftGroups.length + 1;
    const maxM = Math.max(1, parseInt(batchGroupMaxMembers.value, 10) || 5);
    draftGroups.push({
      code: `G${nextNum}`,
      name: formatGroupDefaultName(nextNum),
      password: randomReadablePassword(6),
      maxMembers: maxM
    });
    batchGroupCount.value = String(draftGroups.length);
    renderDraftGroupsTable();
  });

  function parseGroupsFromFileContent(rawText, defaultMaxMembers = 5) {
    const trimmed = String(rawText || '').replace(/^\uFEFF/, '').trim();
    if (!trimmed) return [];

    // 1. 嘗試解析 JSON 格式
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      const parsed = JSON.parse(trimmed);
      const arr = Array.isArray(parsed) ? parsed : parsed.groups;
      if (!Array.isArray(arr)) return [];
      return arr
        .slice(0, 50)
        .map((item, idx) => ({
          code: `G${idx + 1}`,
          name: String(item.name || item.groupName || formatGroupDefaultName(idx + 1))
            .trim()
            .slice(0, 24),
          password: String(item.password || item.groupPassword || randomReadablePassword(6))
            .trim()
            .slice(0, 24),
          maxMembers: Math.max(
            1,
            Math.min(200, parseInt(item.maxMembers, 10) || defaultMaxMembers)
          )
        }))
        .filter((g) => g.name && g.password);
    }

    // 2. 解析 CSV / TSV 格式（支援 RFC-4180 雙引號轉義、欄內逗號，以及 2/3/4 欄格式）
    function parseCsvLine(line) {
      const delimiter = line.includes('\t') && !line.includes(',') ? '\t' : ',';
      const cols = [];
      let cur = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
          if (ch === '"') {
            if (i + 1 < line.length && line[i + 1] === '"') {
              cur += '"';
              i++;
            } else {
              inQuotes = false;
            }
          } else {
            cur += ch;
          }
        } else if (ch === '"' && cur.trim() === '') {
          inQuotes = true;
          cur = '';
        } else if (ch === delimiter) {
          cols.push(cur.trim());
          cur = '';
        } else {
          cur += ch;
        }
      }
      cols.push(cur.trim());
      return cols;
    }

    const lines = trimmed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);

      if (cols.length < 2) continue;

      // 自動偵測並略過第一列標題列
      if (
        i === 0 &&
        (cols[0].includes('組別') ||
          cols[0].includes('代碼') ||
          cols[0].toLowerCase() === 'code' ||
          cols[0].toLowerCase() === 'name' ||
          cols[1].includes('密碼') ||
          cols[1].toLowerCase() === 'password')
      ) {
        continue;
      }

      let name = '';
      let password = '';
      let maxM = defaultMaxMembers;

      // 若第一欄是 G1, G2... 且至少有 3 欄，視為 [代碼, 組別名稱, 組別密碼, 人數上限?]
      if (/^G\d+$/i.test(cols[0]) && cols.length >= 3) {
        name = cols[1];
        password = cols[2];
        if (cols[3]) maxM = parseInt(cols[3], 10) || defaultMaxMembers;
      } else {
        // 否則視為 [組別名稱, 組別密碼, 人數上限?]
        name = cols[0];
        password = cols[1];
        if (cols[2]) maxM = parseInt(cols[2], 10) || defaultMaxMembers;
      }

      if (!name || !password) continue;
      out.push({
        code: `G${out.length + 1}`,
        name: name.slice(0, 24),
        password: password.slice(0, 24),
        maxMembers: Math.max(1, Math.min(200, maxM))
      });
      if (out.length >= 50) break;
    }
    return out;
  }

  if (btnImportGroupsFile && inputImportGroupsFile) {
    btnImportGroupsFile.addEventListener('click', () => {
      inputImportGroupsFile.value = '';
      inputImportGroupsFile.click();
    });

    inputImportGroupsFile.addEventListener('change', async () => {
      const file = inputImportGroupsFile.files && inputImportGroupsFile.files[0];
      if (!file) return;
      try {
        const buffer = await file.arrayBuffer();
        let text = new TextDecoder('utf-8').decode(buffer);
        // 若檔案為 Windows Excel 預設儲存之 ANSI/Big5 編碼，自動切換為 big5 解碼
        if (text.includes('\uFFFD')) {
          try {
            text = new TextDecoder('big5').decode(buffer);
          } catch {
            // keep utf-8 fallback
          }
        }
        const defaultMaxM = Math.max(1, parseInt(batchGroupMaxMembers.value, 10) || 5);
        const importedGroups = parseGroupsFromFileContent(text, defaultMaxM);
        if (importedGroups.length === 0) {
          showToast('找不到有效的組別與密碼資料，請確認檔案格式。', 'error');
          return;
        }
        draftGroups = importedGroups;
        batchGroupCount.value = String(draftGroups.length);
        draftGroupsEdited = true;
        renderDraftGroupsTable();
        showToast(`已成功匯入 ${draftGroups.length} 組名單與密碼`, 'success');
      } catch {
        showToast('讀取組別檔案失敗，請確認格式為 CSV 或 JSON。', 'error');
      }
    });
  }

  if (btnExportGroupsCsv) {
    btnExportGroupsCsv.addEventListener('click', () => {
      const headers = ['組別名稱', '組別密碼', '人數上限'];
      const rows = draftGroups.map((g) => [
        `"${String(g.name).replace(/"/g, '""')}"`,
        `"${String(g.password).replace(/"/g, '""')}"`,
        g.maxMembers
      ]);
      const csvContent =
        '\uFEFF' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'CyberQuiz_組別與密碼清單.csv';
      a.click();
      URL.revokeObjectURL(url);
      showToast('已匯出組別 CSV 範本', 'success');
    });
  }

  hostLoginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFieldError(inputHostPassword, hostPasswordError);
    const username = (inputHostUsername ? inputHostUsername.value.trim() : '') || 'admin';
    const password = inputHostPassword.value;
    if (!password) {
      setFieldError(inputHostPassword, hostPasswordError, '請輸入管理密碼。');
      return;
    }

    btnHostLoginSubmit.disabled = true;
    btnHostLoginSubmit.textContent = '正在登入…';

    try {
      const res = await fetch('/api/host/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setFieldError(inputHostPassword, hostPasswordError, data.error || '帳號或密碼錯誤。');
        return;
      }
      hostToken = data.hostToken;
      currentAdminProfile = data.admin || null;
      sessionStorage.setItem('cyberquiz_host_token', hostToken);
      inputHostPassword.value = '';
      initHostView();
    } catch {
      setFieldError(inputHostPassword, hostPasswordError, '無法連線至伺服器，請檢查網路狀態。');
    } finally {
      btnHostLoginSubmit.disabled = false;
      btnHostLoginSubmit.textContent = '登入';
    }
  });

  // ==================== 題庫管理 (QUESTION BANK CRUD) ====================

  async function loadQuestionsBank() {
    if (!hostToken || !questionsTableBody) return;
    try {
      const { res, data, unauthorized } = await fetchHostApi('/api/host/questions');
      if (unauthorized || !res.ok || !data.ok) return;
      cachedQuestionsBank = data.questions || [];
      renderQuestionsTable();
    } catch {
      showToast('無法載入題庫資料', 'error');
    }
  }

  function renderQuestionsTable() {
    if (!questionsTableBody) return;
    questionsTableBody.textContent = '';
    const superRole = isSuperAdmin();

    if (cachedQuestionsBank.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.className = 'text-muted';
      td.textContent = '目前題庫尚無題目。';
      tr.appendChild(td);
      questionsTableBody.appendChild(tr);
      return;
    }

    cachedQuestionsBank.forEach((q, idx) => {
      const tr = document.createElement('tr');

      // 1. 順序與排序按鈕
      const tdOrder = document.createElement('td');
      const orderWrap = document.createElement('div');
      orderWrap.className = 'inline-form';
      const numSpan = document.createElement('span');
      numSpan.className = 'mono-text';
      numSpan.textContent = `#${idx + 1}`;
      orderWrap.appendChild(numSpan);

      if (superRole) {
        const upBtn = document.createElement('button');
        upBtn.type = 'button';
        upBtn.className = 'btn btn-ghost btn-xs';
        upBtn.textContent = '↑';
        upBtn.title = '上移';
        upBtn.disabled = idx === 0;
        upBtn.addEventListener('click', () => moveQuestionOrder(idx, -1));

        const downBtn = document.createElement('button');
        downBtn.type = 'button';
        downBtn.className = 'btn btn-ghost btn-xs';
        downBtn.textContent = '↓';
        downBtn.title = '下移';
        downBtn.disabled = idx === cachedQuestionsBank.length - 1;
        downBtn.addEventListener('click', () => moveQuestionOrder(idx, 1));

        orderWrap.append(upBtn, downBtn);
      }
      tdOrder.appendChild(orderWrap);

      // 2. 題目標題與情境摘要
      const tdContent = document.createElement('td');
      const titleStrong = document.createElement('strong');
      titleStrong.textContent = q.title;
      const scenarioP = document.createElement('p');
      scenarioP.className = 'text-muted text-sm';
      const snippet =
        q.scenario && q.scenario.length > 72 ? `${q.scenario.slice(0, 72)}…` : q.scenario || '';
      scenarioP.textContent = snippet;
      const optsP = document.createElement('p');
      optsP.className = 'text-muted text-sm';
      optsP.textContent = `A: ${q.options?.A || ''} ｜ B: ${q.options?.B || ''} ｜ C: ${
        q.options?.C || ''
      } ｜ D: ${q.options?.D || ''}`;
      tdContent.append(titleStrong, scenarioP, optsP);

      // 3. 正確答案
      const tdAns = document.createElement('td');
      const ansBadge = document.createElement('span');
      ansBadge.className = 'badge badge-info mono-text';
      ansBadge.textContent = q.answer;
      tdAns.appendChild(ansBadge);

      // 4. 啟用狀態
      const tdStatus = document.createElement('td');
      const stBadge = document.createElement('span');
      stBadge.className = q.isEnabled !== false ? 'badge badge-success' : 'badge';
      stBadge.textContent = q.isEnabled !== false ? '啟用' : '停用';
      tdStatus.appendChild(stBadge);

      // 5. 版本與更新者
      const tdMeta = document.createElement('td');
      tdMeta.className = 'text-muted text-sm';
      tdMeta.textContent = `v${q.version || 1} · ${q.updatedBy || 'system'}`;

      // 6. 操作
      const tdAct = document.createElement('td');
      const actWrap = document.createElement('div');
      actWrap.className = 'inline-form';

      if (superRole) {
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'btn btn-secondary btn-xs';
        editBtn.textContent = '編輯';
        editBtn.addEventListener('click', () => openQuestionModal(q, editBtn));

        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'btn btn-ghost btn-xs';
        toggleBtn.textContent = q.isEnabled !== false ? '停用' : '啟用';
        toggleBtn.addEventListener('click', () => toggleQuestionEnabled(q));

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn btn-destructive-outline btn-xs';
        delBtn.textContent = '刪除';
        delBtn.addEventListener('click', () => confirmDeleteQuestion(q, delBtn));

        actWrap.append(editBtn, toggleBtn, delBtn);
      } else {
        const viewSpan = document.createElement('span');
        viewSpan.className = 'text-muted text-sm';
        viewSpan.textContent = '唯讀';
        actWrap.appendChild(viewSpan);
      }
      tdAct.appendChild(actWrap);

      tr.append(tdOrder, tdContent, tdAns, tdStatus, tdMeta, tdAct);
      questionsTableBody.appendChild(tr);
    });
  }

  async function moveQuestionOrder(index, delta) {
    const targetIdx = index + delta;
    if (targetIdx < 0 || targetIdx >= cachedQuestionsBank.length) return;
    const orderedIds = cachedQuestionsBank.map((q) => q.id);
    const [moved] = orderedIds.splice(index, 1);
    orderedIds.splice(targetIdx, 0, moved);

    const { res, data, unauthorized } = await fetchHostApi('/api/host/questions/reorder', {
      method: 'POST',
      body: JSON.stringify({ orderedIds })
    });
    if (unauthorized) return;
    if (!res.ok || !data.ok) {
      showToast(data.error || '調整順序失敗', 'error');
      return;
    }
    cachedQuestionsBank = data.questions || [];
    renderQuestionsTable();
    showToast('已更新題目順序', 'success');
  }

  function openQuestionModal(q = null, triggerEl = null) {
    clearFieldError(null, questionEditorError);
    if (q) {
      questionEditorModalTitle.textContent = `編輯題目 #${q.number}`;
      editQuestionId.value = String(q.id);
      editQuestionVersion.value = String(q.version || 1);
      inputQuestionTitle.value = q.title || '';
      inputQuestionScenario.value = q.scenario || '';
      inputQuestionOptA.value = q.options?.A || '';
      inputQuestionOptB.value = q.options?.B || '';
      inputQuestionOptC.value = q.options?.C || '';
      inputQuestionOptD.value = q.options?.D || '';
      selectQuestionAnswer.value = q.answer || 'A';
      selectQuestionEnabled.value = q.isEnabled !== false ? 'true' : 'false';
      inputQuestionExplanation.value = q.explanation || '';
    } else {
      questionEditorModalTitle.textContent = '新增題目';
      editQuestionId.value = '';
      editQuestionVersion.value = '';
      inputQuestionTitle.value = '';
      inputQuestionScenario.value = '';
      inputQuestionOptA.value = '';
      inputQuestionOptB.value = '';
      inputQuestionOptC.value = '';
      inputQuestionOptD.value = '';
      selectQuestionAnswer.value = 'A';
      selectQuestionEnabled.value = 'true';
      inputQuestionExplanation.value = '';
    }
    openModal(questionEditorModal, triggerEl || btnOpenAddQuestion);
  }

  if (btnOpenAddQuestion) {
    btnOpenAddQuestion.addEventListener('click', () => openQuestionModal(null, btnOpenAddQuestion));
  }
  if (btnCloseQuestionModal) {
    btnCloseQuestionModal.addEventListener('click', () => closeModal(questionEditorModal));
  }
  if (btnCancelQuestionModal) {
    btnCancelQuestionModal.addEventListener('click', () => closeModal(questionEditorModal));
  }

  if (questionEditorForm) {
    questionEditorForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearFieldError(null, questionEditorError);
      const qId = editQuestionId.value.trim();
      const version = editQuestionVersion.value ? parseInt(editQuestionVersion.value, 10) : undefined;

      const payload = {
        title: inputQuestionTitle.value.trim(),
        scenario: inputQuestionScenario.value.trim(),
        options: {
          A: inputQuestionOptA.value.trim(),
          B: inputQuestionOptB.value.trim(),
          C: inputQuestionOptC.value.trim(),
          D: inputQuestionOptD.value.trim()
        },
        answer: selectQuestionAnswer.value,
        isEnabled: selectQuestionEnabled.value === 'true',
        explanation: inputQuestionExplanation.value.trim(),
        version
      };

      btnSaveQuestionSubmit.disabled = true;
      btnSaveQuestionSubmit.textContent = '正在儲存…';
      try {
        const url = qId ? `/api/host/questions/${encodeURIComponent(qId)}` : '/api/host/questions';
        const method = qId ? 'PUT' : 'POST';
        const { res, data, unauthorized } = await fetchHostApi(url, {
          method,
          body: JSON.stringify(payload)
        });
        if (unauthorized) return;
        if (!res.ok || !data.ok) {
          setFieldError(null, questionEditorError, data.error || '儲存題目失敗', false);
          if (res.status === 409) {
            await loadQuestionsBank();
          }
          return;
        }
        closeModal(questionEditorModal);
        showToast(qId ? '題目已更新' : '已新增題目', 'success');
        await loadQuestionsBank();
      } catch {
        setFieldError(null, questionEditorError, '網路錯誤，請稍後再試。', false);
      } finally {
        btnSaveQuestionSubmit.disabled = false;
        btnSaveQuestionSubmit.textContent = '儲存題目';
      }
    });
  }

  async function toggleQuestionEnabled(q) {
    const nextEnabled = q.isEnabled === false;
    const payload = {
      title: q.title,
      scenario: q.scenario,
      options: q.options,
      answer: q.answer,
      explanation: q.explanation,
      isEnabled: nextEnabled,
      version: q.version
    };
    const { res, data, unauthorized } = await fetchHostApi(
      `/api/host/questions/${encodeURIComponent(q.id)}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload)
      }
    );
    if (unauthorized) return;
    if (!res.ok || !data.ok) {
      showToast(data.error || '變更狀態失敗', 'error');
      await loadQuestionsBank();
      return;
    }
    showToast(nextEnabled ? '已啟用題目' : '已停用題目', 'success');
    await loadQuestionsBank();
  }

  function confirmDeleteQuestion(q, triggerEl) {
    openConfirmDialog({
      title: '刪除題目',
      message: `確定要永久刪除「${q.title}」嗎？進行中的房間不受影響。`,
      confirmText: '確定刪除',
      isDestructive: true,
      triggerEl,
      onConfirm: async () => {
        const { res, data, unauthorized } = await fetchHostApi(
          `/api/host/questions/${encodeURIComponent(q.id)}`,
          { method: 'DELETE' }
        );
        if (unauthorized) return;
        if (!res.ok || !data.ok) {
          showToast(data.error || '刪除題目失敗', 'error');
          return;
        }
        showToast('已刪除題目', 'success');
        await loadQuestionsBank();
      }
    });
  }

  if (btnExportQuestionsJson) {
    btnExportQuestionsJson.addEventListener('click', () => {
      const exportList = cachedQuestionsBank.map((q) => ({
        title: q.title,
        scenario: q.scenario,
        options: q.options,
        answer: q.answer,
        explanation: q.explanation,
        isEnabled: q.isEnabled !== false
      }));
      const blob = new Blob([JSON.stringify(exportList, null, 2)], {
        type: 'application/json;charset=utf-8;'
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `CyberQuiz_Questions_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('已匯出題庫 JSON', 'success');
    });
  }

  if (btnImportQuestionsJson && inputImportQuestionsFile) {
    btnImportQuestionsJson.addEventListener('click', () => {
      inputImportQuestionsFile.value = '';
      inputImportQuestionsFile.click();
    });

    inputImportQuestionsFile.addEventListener('change', async () => {
      const file = inputImportQuestionsFile.files && inputImportQuestionsFile.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const questionsArray = Array.isArray(parsed) ? parsed : parsed.questions;
        if (!Array.isArray(questionsArray) || questionsArray.length === 0) {
          showToast('JSON 格式不正確，需包含題目陣列。', 'error');
          return;
        }
        openConfirmDialog({
          title: '匯入題庫 JSON',
          message: `即將匯入 ${questionsArray.length} 道題目並取代目前中央題庫（進行中房間不受影響），確定繼續嗎？`,
          confirmText: '確定匯入',
          isDestructive: true,
          triggerEl: btnImportQuestionsJson,
          onConfirm: async () => {
            const { res, data, unauthorized } = await fetchHostApi('/api/host/questions/import', {
              method: 'POST',
              body: JSON.stringify({ mode: 'replace', questions: questionsArray })
            });
            if (unauthorized) return;
            if (!res.ok || !data.ok) {
              showToast(data.error || '匯入題庫失敗', 'error');
              return;
            }
            cachedQuestionsBank = data.questions || [];
            renderQuestionsTable();
            showToast(`已成功匯入 ${cachedQuestionsBank.length} 道題目`, 'success');
          }
        });
      } catch {
        showToast('無法解析 JSON 檔案，請確認格式。', 'error');
      }
    });
  }

  if (btnResetDefaultQuestions) {
    btnResetDefaultQuestions.addEventListener('click', () => {
      openConfirmDialog({
        title: '還原預設 10 題',
        message: '這會將中央題庫還原為系統內建的 10 道預設題目，確定要還原嗎？',
        confirmText: '確定還原',
        isDestructive: true,
        triggerEl: btnResetDefaultQuestions,
        onConfirm: async () => {
          const { res, data, unauthorized } = await fetchHostApi('/api/host/questions/reset', {
            method: 'POST'
          });
          if (unauthorized) return;
          if (!res.ok || !data.ok) {
            showToast(data.error || '還原題庫失敗', 'error');
            return;
          }
          cachedQuestionsBank = data.questions || [];
          renderQuestionsTable();
          showToast('已還原預設 10 道題目', 'success');
        }
      });
    });
  }

  // ==================== 管理者帳號與稽核日誌 (ADMIN & AUDIT LOGS) ====================

  async function loadAdminsAndLogs() {
    if (!hostToken || !isSuperAdmin()) return;
    await Promise.all([loadAdminsList(), loadAuditLogsList()]);
  }

  async function loadAdminsList() {
    if (!adminsTableBody) return;
    try {
      const { res, data, unauthorized } = await fetchHostApi('/api/host/admins');
      if (unauthorized || !res.ok || !data.ok) return;
      cachedAdminsList = data.admins || [];
      renderAdminsTable();
    } catch {
      showToast('無法載入管理者清單', 'error');
    }
  }

  function renderAdminsTable() {
    if (!adminsTableBody) return;
    adminsTableBody.textContent = '';

    cachedAdminsList.forEach((a) => {
      const tr = document.createElement('tr');

      const tdUser = document.createElement('td');
      tdUser.className = 'mono-text';
      tdUser.textContent = a.username;

      const tdName = document.createElement('td');
      const strongName = document.createElement('strong');
      strongName.textContent = a.displayName;
      tdName.appendChild(strongName);

      const tdRole = document.createElement('td');
      const roleBadge = document.createElement('span');
      roleBadge.className = a.adminRole === 'super_admin' ? 'badge badge-info' : 'badge';
      roleBadge.textContent = a.adminRole === 'super_admin' ? '最高管理員' : '一般主持人';
      tdRole.appendChild(roleBadge);

      const tdStatus = document.createElement('td');
      const stBadge = document.createElement('span');
      stBadge.className = a.isActive ? 'badge badge-success' : 'badge badge-warning';
      stBadge.textContent = a.isActive ? '啟用中' : '已停用';
      tdStatus.appendChild(stBadge);

      const tdLogin = document.createElement('td');
      tdLogin.className = 'text-muted text-sm';
      tdLogin.textContent = a.lastLoginAt
        ? new Date(a.lastLoginAt).toLocaleString('zh-TW', { hour12: false })
        : '尚未登入';

      const tdAct = document.createElement('td');
      const actWrap = document.createElement('div');
      actWrap.className = 'inline-form';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-secondary btn-xs';
      editBtn.textContent = '編輯／重設密碼';
      editBtn.addEventListener('click', () => openAdminModal(a, editBtn));
      actWrap.appendChild(editBtn);

      const isSelf = currentAdminProfile && currentAdminProfile.username === a.username;
      if (!isSelf) {
        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = a.isActive
          ? 'btn btn-destructive-outline btn-xs'
          : 'btn btn-ghost btn-xs';
        toggleBtn.textContent = a.isActive ? '停用帳號' : '啟用帳號';
        toggleBtn.addEventListener('click', () => toggleAdminActiveState(a, toggleBtn));
        actWrap.appendChild(toggleBtn);
      }

      tdAct.appendChild(actWrap);
      tr.append(tdUser, tdName, tdRole, tdStatus, tdLogin, tdAct);
      adminsTableBody.appendChild(tr);
    });
  }

  function openAdminModal(adminObj = null, triggerEl = null) {
    clearFieldError(null, adminEditorError);
    if (adminObj) {
      adminEditorModalTitle.textContent = `編輯管理者：${adminObj.username}`;
      editAdminId.value = String(adminObj.id);
      inputAdminUsername.value = adminObj.username;
      inputAdminUsername.readOnly = true;
      inputAdminDisplayName.value = adminObj.displayName || '';
      selectAdminRole.value = adminObj.adminRole || 'host';
      labelAdminPassword.textContent = '重設密碼（若不修改請留白）';
      inputAdminPassword.value = '';
      inputAdminPassword.required = false;
    } else {
      adminEditorModalTitle.textContent = '新增管理者';
      editAdminId.value = '';
      inputAdminUsername.value = '';
      inputAdminUsername.readOnly = false;
      inputAdminDisplayName.value = '';
      selectAdminRole.value = 'host';
      labelAdminPassword.textContent = '登入密碼（至少 8 字元）';
      inputAdminPassword.value = '';
      inputAdminPassword.required = true;
    }
    openModal(adminEditorModal, triggerEl || btnOpenAddAdmin);
  }

  if (btnOpenAddAdmin) {
    btnOpenAddAdmin.addEventListener('click', () => openAdminModal(null, btnOpenAddAdmin));
  }
  if (btnCloseAdminModal) {
    btnCloseAdminModal.addEventListener('click', () => closeModal(adminEditorModal));
  }
  if (btnCancelAdminModal) {
    btnCancelAdminModal.addEventListener('click', () => closeModal(adminEditorModal));
  }

  if (adminEditorForm) {
    adminEditorForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearFieldError(null, adminEditorError);
      const adminId = editAdminId.value.trim();
      const username = inputAdminUsername.value.trim();
      const displayName = inputAdminDisplayName.value.trim();
      const adminRole = selectAdminRole.value;
      const password = inputAdminPassword.value;

      btnSaveAdminSubmit.disabled = true;
      btnSaveAdminSubmit.textContent = '正在儲存…';
      try {
        const url = adminId
          ? `/api/host/admins/${encodeURIComponent(adminId)}`
          : '/api/host/admins';
        const method = adminId ? 'PATCH' : 'POST';
        const bodyObj = adminId
          ? { displayName, adminRole, ...(password ? { password } : {}) }
          : { username, displayName, adminRole, password };

        const { res, data, unauthorized } = await fetchHostApi(url, {
          method,
          body: JSON.stringify(bodyObj)
        });
        if (unauthorized) return;
        if (!res.ok || !data.ok) {
          setFieldError(null, adminEditorError, data.error || '儲存管理者失敗', false);
          return;
        }
        closeModal(adminEditorModal);
        if (
          adminId &&
          password &&
          currentAdminProfile &&
          Number(adminId) === Number(currentAdminProfile.id)
        ) {
          showToast('密碼已更新，請重新登入', 'success');
          handleHostUnauthorized('您的密碼已更新，請使用新密碼重新登入。');
          return;
        }
        showToast(adminId ? '已更新管理者設定' : '已新增管理者帳號', 'success');
        await loadAdminsAndLogs();
      } catch {
        setFieldError(null, adminEditorError, '網路錯誤，請稍後再試。', false);
      } finally {
        btnSaveAdminSubmit.disabled = false;
        btnSaveAdminSubmit.textContent = '儲存帳號';
      }
    });
  }

  function toggleAdminActiveState(adminObj, triggerEl) {
    const nextActive = !adminObj.isActive;
    openConfirmDialog({
      title: nextActive ? '啟用管理者帳號' : '停用管理者帳號',
      message: nextActive
        ? `確定要重新啟用「${adminObj.displayName} (${adminObj.username})」嗎？`
        : `確定要停用「${adminObj.displayName} (${adminObj.username})」嗎？停用後該帳號目前已登入的連線將立即失效。`,
      confirmText: nextActive ? '確定啟用' : '確定停用',
      isDestructive: !nextActive,
      triggerEl,
      onConfirm: async () => {
        const { res, data, unauthorized } = await fetchHostApi(
          `/api/host/admins/${encodeURIComponent(adminObj.id)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ isActive: nextActive })
          }
        );
        if (unauthorized) return;
        if (!res.ok || !data.ok) {
          showToast(data.error || '變更帳號狀態失敗', 'error');
          return;
        }
        showToast(nextActive ? '已啟用帳號' : '已停用帳號並撤銷憑證', 'success');
        await loadAdminsAndLogs();
      }
    });
  }

  async function loadAuditLogsList() {
    if (!auditLogsTableBody) return;
    try {
      const { res, data, unauthorized } = await fetchHostApi('/api/host/audit-logs?limit=80');
      if (unauthorized || !res.ok || !data.ok) return;
      const logs = data.logs || [];
      auditLogsTableBody.textContent = '';
      if (logs.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 5;
        td.className = 'text-muted';
        td.textContent = '尚無操作稽核紀錄。';
        tr.appendChild(td);
        auditLogsTableBody.appendChild(tr);
        return;
      }

      logs.forEach((log) => {
        const tr = document.createElement('tr');

        const tdTime = document.createElement('td');
        tdTime.className = 'text-muted text-sm mono-text';
        tdTime.textContent = log.createdAt
          ? new Date(log.createdAt).toLocaleString('zh-TW', { hour12: false })
          : '-';

        const tdActor = document.createElement('td');
        tdActor.textContent = log.actorUsername || '-';

        const tdAction = document.createElement('td');
        const actBadge = document.createElement('span');
        actBadge.className = 'badge mono-text';
        actBadge.textContent = log.action;
        tdAction.appendChild(actBadge);

        const tdDetail = document.createElement('td');
        tdDetail.className = 'text-sm';
        const targetLabel =
          log.targetType && log.targetId ? `[${log.targetType}:${log.targetId}] ` : '';
        tdDetail.textContent = `${targetLabel}${log.detail || ''}`.trim() || '-';

        const tdIp = document.createElement('td');
        tdIp.className = 'text-muted text-sm mono-text';
        tdIp.textContent = log.clientIp || '-';

        tr.append(tdTime, tdActor, tdAction, tdDetail, tdIp);
        auditLogsTableBody.appendChild(tr);
      });
    } catch {
      // ignore
    }
  }

  if (btnRefreshAuditLogs) {
    btnRefreshAuditLogs.addEventListener('click', loadAuditLogsList);
  }

  if (btnSyncRoomQuestions) {
    btnSyncRoomQuestions.addEventListener('click', async () => {
      const pin = currentHostState?.pin || currentHostPin;
      if (!pin || !hostToken) return;
      btnSyncRoomQuestions.disabled = true;
      btnSyncRoomQuestions.textContent = '正在同步…';
      try {
        const { res, data, unauthorized } = await fetchHostApi(
          `/api/host/rooms/${encodeURIComponent(pin)}/sync-questions`,
          { method: 'POST' }
        );
        if (unauthorized) return;
        if (!res.ok || !data.ok) {
          showToast(data.error || '同步題庫失敗', 'error');
          return;
        }
        if (data.room) {
          currentHostState = data.room;
          renderHostScreen();
        }
        const totalQ = data.totalQuestions ?? data.room?.totalQuestions ?? 0;
        showToast(`已同步最新啟用題庫（共 ${totalQ} 題）`, 'success');
      } catch {
        showToast('同步題庫時發生網路錯誤', 'error');
      } finally {
        btnSyncRoomQuestions.disabled = false;
        btnSyncRoomQuestions.textContent = '同步題庫';
      }
    });
  }

  hostCreateRoomForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!hostToken) return;
    clearFieldError(null, createRoomError);

    btnCreateRoomSubmit.disabled = true;
    btnCreateRoomSubmit.textContent = '正在建立…';

    try {
      const payload = {
        title: setupRoomTitle.value.trim(),
        maxPlayers: parseInt(setupMaxPlayers.value, 10) || 100,
        timeLimitSec: parseInt(setupTimeLimit.value, 10) || 25,
        groups: draftGroups
      };

      const res = await fetch('/api/host/rooms', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${hostToken}`
        },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.status === 401) {
        sessionStorage.removeItem('cyberquiz_host_token');
        hostToken = null;
        initHostView();
        setFieldError(inputHostPassword, hostPasswordError, '登入憑證已過期，請重新登入。');
        return;
      }
      if (!res.ok || !data.ok) {
        setFieldError(null, createRoomError, data.error || '建立房間失敗。', false);
        return;
      }

      currentHostPin = data.room.pin;
      sessionStorage.setItem('cyberquiz_host_pin', currentHostPin);
      currentHostState = data.room;
      renderHostScreen();
      subscribeHostToRoom(currentHostPin);
      if (setupBgmMode && setupBgmMode.value && setupBgmMode.value !== 'off') {
        if (selectHostBgmTrack) {
          selectHostBgmTrack.value = setupBgmMode.value;
        }
        startBgmPlayback(setupBgmMode.value);
      }
    } catch {
      setFieldError(null, createRoomError, '建立房間時發生網路錯誤，請重試。', false);
    } finally {
      btnCreateRoomSubmit.disabled = false;
      btnCreateRoomSubmit.textContent = '建立房間';
    }
  });

  btnReconnectRoom.addEventListener('click', () => {
    clearFieldError(inputReconnectPin, reconnectPinError);
    const pin = inputReconnectPin.value.trim();
    if (!/^\d{6}$/.test(pin)) {
      setFieldError(inputReconnectPin, reconnectPinError, '請輸入 6 位數房間 PIN。');
      return;
    }
    subscribeHostToRoom(pin);
  });

  async function subscribeHostToRoom(pin) {
    if (!hostToken || !pin) return;
    const cleanPin = String(pin).trim();
    currentHostPin = cleanPin;
    sessionStorage.setItem('cyberquiz_host_pin', cleanPin);
    btnReconnectRoom.disabled = true;
    btnReconnectRoom.textContent = '正在連線…';

    try {
      const { res, data, unauthorized } = await fetchHostApi(
        `/api/host/rooms/${encodeURIComponent(cleanPin)}`
      );
      if (unauthorized) return;
      if (!res.ok || !data.ok) {
        sessionStorage.removeItem('cyberquiz_host_pin');
        currentHostPin = null;
        openHostSetupScreen();
        if (data?.error) {
          setFieldError(inputReconnectPin, reconnectPinError, data.error, false);
        }
        return;
      }
      currentHostState = data.room;
      if (data.room?.serverNowEpoch) {
        serverClockOffsetMs = data.room.serverNowEpoch - Date.now();
      }
      renderHostScreen();
    } catch {
      // fallback to socket subscribe below
    } finally {
      btnReconnectRoom.disabled = false;
      btnReconnectRoom.textContent = '重連房間';
    }

    if (!socket.connected) {
      socket.connect();
    }
    socket.emit('host:subscribe', { pin: cleanPin, hostToken }, (ack) => {
      if (!ack || !ack.ok) return;
      currentHostPin = ack.room.pin;
      sessionStorage.setItem('cyberquiz_host_pin', currentHostPin);
      currentHostState = ack.room;
      if (ack.room.serverNowEpoch) {
        serverClockOffsetMs = ack.room.serverNowEpoch - Date.now();
      }
      renderHostScreen();
    });
  }

  function promptNewRoom(triggerButton) {
    const pin = currentHostState?.pin || currentHostPin || '';
    openConfirmDialog({
      title: '重新建立房間',
      message: `目前房間（PIN：${pin}）仍會保留於系統中，可隨時輸入 PIN 重連。確定要前往建立新房間嗎？`,
      confirmText: '前往建立',
      triggerEl: triggerButton,
      onConfirm: () => {
        currentHostPin = null;
        sessionStorage.removeItem('cyberquiz_host_pin');
        openHostSetupScreen();
      }
    });
  }

  btnHostNewRoom.addEventListener('click', () => promptNewRoom(btnHostNewRoom));
  if (btnHostDeleteRoom) {
    btnHostDeleteRoom.addEventListener('click', () => {
      const pin = currentHostState?.pin || currentHostPin;
      if (!pin) return;
      confirmDeleteRoom(
        pin,
        currentHostState?.title,
        currentHostState?.currentPlayers,
        btnHostDeleteRoom
      );
    });
  }
  if (btnFinishedNewRoom) {
    btnFinishedNewRoom.addEventListener('click', () => promptNewRoom(btnFinishedNewRoom));
  }

  async function executeHostRoomAction(
    action,
    extraPayload = {},
    buttonEl = null,
    loadingText = '處理中…'
  ) {
    if (!currentHostPin || !hostToken) return false;
    const prevText = buttonEl ? buttonEl.textContent : '';
    if (buttonEl) {
      buttonEl.disabled = true;
      buttonEl.textContent = loadingText;
    }
    try {
      const { res, data, unauthorized } = await fetchHostApi(
        `/api/host/rooms/${encodeURIComponent(currentHostPin)}/action`,
        {
          method: 'POST',
          body: JSON.stringify(Object.assign({ action }, extraPayload))
        }
      );
      if (unauthorized) return false;
      if (!res.ok || !data.ok) {
        showToast(data?.error || '操作失敗', 'error');
        return false;
      }
      if (data.room) {
        currentHostState = data.room;
        if (data.room.serverNowEpoch) {
          serverClockOffsetMs = data.room.serverNowEpoch - Date.now();
        }
        renderHostScreen();
      }
      return true;
    } catch {
      showToast('網路連線異常，請重試', 'error');
      return false;
    } finally {
      if (buttonEl) {
        buttonEl.disabled = false;
        buttonEl.textContent = prevText;
      }
    }
  }

  function triggerNextQuestion(buttonEl) {
    executeHostRoomAction('next_question', {}, buttonEl, '正在載入…');
  }

  btnHostNextQuestion.addEventListener('click', () => triggerNextQuestion(btnHostNextQuestion));
  btnHostSkipToNext.addEventListener('click', () => triggerNextQuestion(btnHostSkipToNext));

  btnHostRevealAnswer.addEventListener('click', () => {
    if (!currentHostPin || !hostToken) return;
    const total = currentHostState?.currentPlayers || 0;
    const answered = currentHostState?.answeredCount || 0;
    const unanswered = Math.max(0, total - answered);

    const doReveal = () => {
      executeHostRoomAction('reveal_answer', {}, btnHostRevealAnswer, '正在截止…');
    };

    if (unanswered > 0) {
      openConfirmDialog({
        title: '提前截止作答',
        message: `尚有 ${unanswered} 人未作答，確定提前截止嗎？`,
        confirmText: '提前截止',
        isDestructive: true,
        triggerEl: btnHostRevealAnswer,
        onConfirm: doReveal
      });
    } else {
      doReveal();
    }
  });

  btnHostShowLeaderboard.addEventListener('click', () => {
    executeHostRoomAction('show_leaderboard', {}, btnHostShowLeaderboard, '正在載入…');
  });

  btnHostFinishGame.addEventListener('click', () => {
    if (!currentHostPin || !hostToken) return;
    openConfirmDialog({
      title: '結束比賽',
      message: '結束後將公布最終排名，且無法繼續作答。確定結束比賽嗎？',
      confirmText: '結束比賽',
      isDestructive: true,
      triggerEl: btnHostFinishGame,
      onConfirm: () => {
        executeHostRoomAction('finish_game', {}, btnHostFinishGame, '正在結算…');
      }
    });
  });

  btnTogglePasswordsModal.addEventListener('click', () => {
    if (!currentHostState) return;
    if (isProjectorSafeMode) {
      openConfirmDialog({
        title: '投影模式提醒',
        message: '目前處於投影模式，顯示組別密碼可能會被現場參賽者看到。確定要查看組別密碼嗎？',
        confirmText: '仍要查看',
        triggerEl: btnTogglePasswordsModal,
        onConfirm: () => {
          renderPasswordsModal();
          openModal(passwordsModal, btnTogglePasswordsModal);
        }
      });
      return;
    }
    renderPasswordsModal();
    openModal(passwordsModal, btnTogglePasswordsModal);
  });

  btnClosePasswordsModal.addEventListener('click', () => {
    closeModal(passwordsModal);
  });

  btnCopyAllPasswords.addEventListener('click', async () => {
    if (!currentHostState) return;
    const lines = [
      `${currentHostState.title}`,
      `連線網址：${window.location.origin}/?pin=${currentHostState.pin}`,
      `房間 PIN：${currentHostState.pin}`,
      `人數上限：${currentHostState.maxPlayers} 人`,
      `----------------------------------------`
    ];
    (currentHostState.hostGroups || []).forEach((g) => {
      lines.push(`${g.name}｜密碼：${g.password}｜人數：${g.currentMembers}／${g.maxMembers} 人`);
    });
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      showToast('已複製全部組別密碼', 'success');
    } catch {
      showToast('複製失敗，請手動選取複製', 'error');
    }
  });

  function renderPasswordsModal() {
    modalPasswordsList.textContent = '';
    if (!currentHostState || !Array.isArray(currentHostState.hostGroups)) return;
    const pin = currentHostState.pin;

    currentHostState.hostGroups.forEach((g) => {
      const row = document.createElement('div');
      row.className = 'pwd-row';

      const left = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = `${g.name}　`;
      const cap = document.createElement('span');
      cap.className = 'text-muted text-sm';
      cap.textContent = `人數：${g.currentMembers}／${g.maxMembers} 人｜`;
      const pwdSpan = document.createElement('span');
      pwdSpan.className = 'mono-text';
      pwdSpan.textContent = `密碼：${g.password}`;
      left.append(strong, cap, pwdSpan);

      const right = document.createElement('div');
      right.className = 'pwd-row-actions';

      const copyGroupBtn = document.createElement('button');
      copyGroupBtn.type = 'button';
      copyGroupBtn.className = 'btn btn-primary btn-xs';
      copyGroupBtn.textContent = '複製此組';
      copyGroupBtn.addEventListener('click', async () => {
        const directUrl = `${window.location.origin}/?pin=${encodeURIComponent(
          pin
        )}&group=${encodeURIComponent(g.code)}`;
        const text = [
          `${currentHostState.title} — ${g.name}`,
          `網址：${directUrl}`,
          `房間 PIN：${pin}`,
          `組別：${g.name}`,
          `組別密碼：${g.password}（上限 ${g.maxMembers} 人）`
        ].join('\n');
        try {
          await navigator.clipboard.writeText(text);
          showToast(`已複製 ${g.name} 密碼`, 'success');
        } catch {
          showToast('複製失敗', 'error');
        }
      });

      right.appendChild(copyGroupBtn);
      row.append(left, right);
      modalPasswordsList.appendChild(row);
    });
  }

  function renderHostScreen() {
    if (!currentHostState) return;

    hostSetupCard.classList.add('hidden');
    hostActiveRoomArea.classList.remove('hidden');

    const st = currentHostState;
    hostPinDisplay.textContent = st.pin;
    hostRoomTitleDisplay.textContent = st.title;
    hostPlayerCountPill.textContent = `目前人數：${st.currentPlayers}／${st.maxPlayers} 人`;
    if (hostHeaderQrImg && st.pin) {
      hostHeaderQrImg.src = `/api/qrcode?pin=${encodeURIComponent(st.pin)}`;
    }
    if (hostQuestionCountPill) {
      hostQuestionCountPill.textContent = `本房題數：${st.totalQuestions || 10} 題`;
    }
    if (btnSyncRoomQuestions) {
      const canSync = st.status === 'LOBBY' && !isDisplayOnlyMode && !isProjectorSafeMode;
      btnSyncRoomQuestions.classList.toggle('hidden', !canSync);
    }

    btnHostNextQuestion.classList.add('hidden');
    btnHostRevealAnswer.classList.add('hidden');
    btnHostShowLeaderboard.classList.add('hidden');
    btnHostFinishGame.classList.add('hidden');
    btnHostSkipToNext.classList.add('hidden');

    hostLobbyPanel.classList.add('hidden');
    hostQuestionPanel.classList.add('hidden');
    hostLeaderboardPanel.classList.add('hidden');

    const isLastQuestion = st.currentQuestionIndex + 1 >= st.totalQuestions;

    if (st.status === 'LOBBY') {
      hostStatusPill.textContent = '尚未開始';
      hostStatusPill.className = 'badge badge-info';
      btnHostNextQuestion.textContent = '開始第一題';
      btnHostNextQuestion.classList.remove('hidden');
      hostLobbyPanel.classList.remove('hidden');
      if (hostLobbyQrImg && st.pin) {
        hostLobbyQrImg.src = `/api/qrcode?pin=${encodeURIComponent(st.pin)}`;
      }
      if (hostLobbyQrPinText && st.pin) {
        hostLobbyQrPinText.textContent = st.pin;
      }
      if (hostLobbyQrUrlText && st.pin) {
        hostLobbyQrUrlText.textContent = `${window.location.origin}/?pin=${st.pin}`;
      }
      renderHostLobby(st);
    } else if (st.status === 'QUESTION_OPEN') {
      hostStatusPill.textContent = `第 ${st.currentQuestionIndex + 1} 題作答中`;
      hostStatusPill.className = 'badge badge-warning';
      btnHostRevealAnswer.textContent = '提前截止';
      btnHostRevealAnswer.classList.remove('hidden');
      hostQuestionPanel.classList.remove('hidden');
      renderHostQuestion(st, false);
      startClientCountdown();
    } else if (st.status === 'QUESTION_REVEAL') {
      hostStatusPill.textContent = `第 ${st.currentQuestionIndex + 1} 題答案揭曉`;
      hostStatusPill.className = 'badge badge-success';
      btnHostShowLeaderboard.textContent = '查看排行榜';
      btnHostShowLeaderboard.classList.remove('hidden');
      if (!isLastQuestion) {
        btnHostSkipToNext.textContent = '略過排行榜，直接下一題';
        btnHostSkipToNext.classList.remove('hidden');
      }

      hostQuestionPanel.classList.remove('hidden');
      renderHostQuestion(st, true);
    } else if (st.status === 'LEADERBOARD') {
      hostStatusPill.textContent = '目前排行榜';
      hostStatusPill.className = 'badge badge-info';
      if (isLastQuestion) {
        btnHostFinishGame.textContent = '結束比賽';
        btnHostFinishGame.classList.remove('hidden');
      } else {
        btnHostNextQuestion.textContent = '開始下一題';
        btnHostNextQuestion.classList.remove('hidden');
      }

      hostLeaderboardPanel.classList.remove('hidden');
      hostPodiumSection.classList.add('hidden');
      if (hostAllQuestionsMvpCard) hostAllQuestionsMvpCard.classList.add('hidden');
      renderQuestionMvpBannerDom(hostQuestionMvpBanner, st.currentQuestionMvp);
      renderIndividualLeaderboardDom(
        hostIndividualLeaderboard,
        st.leaderboard,
        !isDisplayOnlyMode && !isProjectorSafeMode,
        null,
        true
      );
      renderGroupLeaderboardDom(hostGroupLeaderboard, st.groupLeaderboard);
    } else if (st.status === 'FINISHED') {
      hostStatusPill.textContent = '已結束';
      hostStatusPill.className = 'badge';
      hostLeaderboardPanel.classList.remove('hidden');
      hostPodiumSection.classList.remove('hidden');
      renderQuestionMvpBannerDom(hostQuestionMvpBanner, null);
      renderPodiumDom(hostPodiumContainer, st.leaderboard.slice(0, 3));
      renderIndividualLeaderboardDom(hostIndividualLeaderboard, st.leaderboard, false, null, false);
      renderGroupLeaderboardDom(hostGroupLeaderboard, st.groupLeaderboard);
      if (hostAllQuestionsMvpCard && Array.isArray(st.allQuestionsReview)) {
        hostAllQuestionsMvpCard.classList.remove('hidden');
        renderHostAllQuestionsMvpDom(hostAllQuestionsMvpList, st.allQuestionsReview);
      } else if (hostAllQuestionsMvpCard) {
        hostAllQuestionsMvpCard.classList.add('hidden');
      }
    }

    syncBgmWithHostStage(st);
    updateConnectionInteractivity();
  }

  function renderHostLobby(st) {
    hostGroupsStatusList.textContent = '';
    const groupsToShow =
      st.hostGroups ||
      (st.groupLeaderboard || []).map((g) => ({
        name: g.name,
        currentMembers: g.memberCount,
        maxMembers: g.maxMembers
      }));

    groupsToShow.forEach((g) => {
      const row = document.createElement('div');
      row.className = 'group-status-row';

      const nameEl = document.createElement('strong');
      nameEl.textContent = g.name;

      const countBadge = document.createElement('span');
      const isFull = g.currentMembers >= g.maxMembers;
      countBadge.className = isFull ? 'badge badge-warning' : 'badge';
      countBadge.textContent = `${g.currentMembers}／${g.maxMembers} 人${isFull ? '（已額滿）' : ''}`;

      row.append(nameEl, countBadge);
      hostGroupsStatusList.appendChild(row);
    });

    hostPlayersGrid.textContent = '';
    if (!st.leaderboard || st.leaderboard.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'text-muted';
      empty.textContent = '目前尚無參賽者加入。';
      hostPlayersGrid.appendChild(empty);
      return;
    }

    const allowKick = !isDisplayOnlyMode && !isProjectorSafeMode;
    st.leaderboard.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'player-list-row';

      const left = document.createElement('div');
      left.className = 'player-row-left';

      const nameStrong = document.createElement('strong');
      nameStrong.textContent = p.nickname;

      const grpBadge = document.createElement('span');
      grpBadge.className = 'badge';
      grpBadge.textContent = p.groupName;

      left.append(nameStrong, grpBadge);

      const right = document.createElement('div');
      right.className = 'player-row-right';

      const connBadge = document.createElement('span');
      connBadge.className =
        p.connected !== false ? 'badge badge-success' : 'badge badge-warning';
      connBadge.textContent = p.connected !== false ? '已連線' : '重新連線中';
      right.appendChild(connBadge);

      if (allowKick) {
        const menu = document.createElement('details');
        menu.className = 'more-actions-menu';

        const summary = document.createElement('summary');
        summary.className = 'more-actions-summary';
        summary.textContent = '更多操作';

        const dropdown = document.createElement('div');
        dropdown.className = 'more-actions-dropdown';

        const kickBtn = document.createElement('button');
        kickBtn.type = 'button';
        kickBtn.className = 'btn btn-destructive btn-xs';
        kickBtn.textContent = '移除參賽者';
        kickBtn.addEventListener('click', () => {
          menu.open = false;
          openConfirmDialog({
            title: '移除參賽者',
            message: `確定移除「${p.nickname}」嗎？移除後將釋放${p.groupName}的名額。`,
            confirmText: '確定移除',
            isDestructive: true,
            triggerEl: summary,
            onConfirm: () => {
              executeHostRoomAction('kick_player', { playerId: p.id });
            }
          });
        });

        dropdown.appendChild(kickBtn);
        menu.append(summary, dropdown);
        right.appendChild(menu);
      }

      row.append(left, right);
      hostPlayersGrid.appendChild(row);
    });
  }

  function renderHostQuestion(st, isReveal) {
    const q = st.question;
    if (!q) return;

    hostQNumberBadge.textContent = `第 ${q.number}／${q.total} 題`;
    hostAnsweredCounter.textContent = `${st.answeredCount}／${st.currentPlayers}`;
    hostQTitle.textContent = `${q.number}. ${q.title}`;
    hostQScenario.textContent = q.scenario;

    ['A', 'B', 'C', 'D'].forEach((optKey) => {
      const textEl = document.getElementById(`hostOptText${optKey}`);
      const countEl = document.getElementById(`hostOptCount${optKey}`);
      const barWrapEl = document.getElementById(`hostOptBarWrap${optKey}`);
      const barFillEl = document.getElementById(`hostOptBar${optKey}`);
      const cardEl = document.querySelector(`.host-opt-card[data-opt="${optKey}"]`);

      textEl.textContent = q.options[optKey] || '';

      if (isReveal && st.optionDistribution) {
        const count = st.optionDistribution[optKey] || 0;
        const totalAns = Math.max(1, st.answeredCount);
        const pct = st.answeredCount > 0 ? Math.round((count / totalAns) * 100) : 0;

        countEl.textContent = `${count} 人 (${pct}%)`;
        countEl.classList.remove('hidden');
        barWrapEl.classList.remove('hidden');
        barFillEl.style.width = `${pct}%`;

        if (q.answer === optKey) {
          cardEl.classList.add('correct-highlight');
          cardEl.classList.remove('wrong-dimmed');
        } else {
          cardEl.classList.remove('correct-highlight');
          cardEl.classList.add('wrong-dimmed');
        }
      } else {
        countEl.classList.add('hidden');
        barWrapEl.classList.add('hidden');
        barFillEl.style.width = '0%';
        cardEl.classList.remove('correct-highlight', 'wrong-dimmed');
      }
    });

    if (isReveal && q.answer) {
      hostExplanationBox.classList.remove('hidden');
      hostCorrectAnswerPill.textContent = `正確答案：${q.answer}`;
      hostExplanationText.textContent = q.explanation || '';
      renderHostRevealMvpLineDom(hostRevealMvpLine, st.currentQuestionMvp);
      hostTimerDisplay.textContent = '0 秒';
      hostTimerBar.style.width = '0%';
      hostTimerBar.classList.remove('timer-warning');
      if (hostTimerBox) hostTimerBox.classList.remove('timer-warning');
    } else {
      hostExplanationBox.classList.add('hidden');
      if (hostRevealMvpLine) hostRevealMvpLine.classList.add('hidden');
    }
  }

  // ==================== 共用渲染與計時器 ====================

  function formatMvpWinnerNames(winners) {
    if (!Array.isArray(winners) || winners.length === 0) return '';
    const joined = winners.map((w) => `${w.nickname}（${w.groupName}）`).join('、');
    return winners.length > 1 ? `${joined}（並列）` : joined;
  }

  function renderHostRevealMvpLineDom(el, mvp) {
    if (!el) return;
    el.textContent = '';
    if (!mvp) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    if (mvp.status === 'has_winner' && Array.isArray(mvp.winners) && mvp.winners.length > 0) {
      el.className = 'host-reveal-mvp-line is-winner';
      const secText = typeof mvp.elapsedMs === 'number' ? `${(mvp.elapsedMs / 1000).toFixed(2)} 秒` : '';
      el.textContent = `👑 本題最高分：${formatMvpWinnerNames(
        mvp.winners
      )}　+${mvp.points.toLocaleString()} 分${secText ? `（含連勝加成 · ${secText}）` : ''}`;
    } else if (mvp.status === 'all_wrong') {
      el.className = 'host-reveal-mvp-line is-empty';
      el.textContent = '💀 本題最高分：從缺（全軍覆沒，無人答對）';
    } else if (mvp.status === 'no_record') {
      el.className = 'host-reveal-mvp-line is-empty';
      el.textContent = '本題最高分：從缺（本題未結算）';
    } else if (mvp.status === 'not_played') {
      el.className = 'host-reveal-mvp-line is-empty';
      el.textContent = '本題最高分：從缺（本題未進行）';
    } else {
      el.className = 'host-reveal-mvp-line is-empty';
      el.textContent = '本題最高分：從缺（本題無人作答）';
    }
  }

  function renderQuestionMvpBannerDom(bannerEl, mvp) {
    if (!bannerEl) return;
    bannerEl.textContent = '';
    if (!mvp) {
      bannerEl.classList.add('hidden');
      return;
    }
    bannerEl.classList.remove('hidden');

    if (mvp.status === 'has_winner' && Array.isArray(mvp.winners) && mvp.winners.length > 0) {
      bannerEl.className = 'mvp-spotlight-banner is-winner';

      const left = document.createElement('div');
      left.className = 'mvp-banner-left';

      const tag = document.createElement('span');
      tag.className = 'mvp-banner-kicker';
      tag.textContent = `⚡ 第 ${mvp.questionNumber} 題 單題最高分 MVP`;

      const namesWrap = document.createElement('div');
      namesWrap.className = 'mvp-banner-winners';

      mvp.winners.forEach((w) => {
        const chip = document.createElement('span');
        chip.className = 'mvp-winner-chip';

        const crownName = document.createElement('strong');
        crownName.textContent = `👑 ${w.nickname}`;

        const grpBadge = document.createElement('span');
        grpBadge.className = 'badge';
        grpBadge.textContent = w.groupName;

        chip.append(crownName, grpBadge);
        namesWrap.appendChild(chip);
      });

      if (mvp.winners.length > 1) {
        const tieTag = document.createElement('span');
        tieTag.className = 'badge badge-warning';
        tieTag.textContent = '並列單題王';
        namesWrap.appendChild(tieTag);
      }

      left.append(tag, namesWrap);

      const right = document.createElement('div');
      right.className = 'mvp-banner-right';

      const ptsStrong = document.createElement('strong');
      ptsStrong.className = 'mvp-banner-points mono-text';
      ptsStrong.textContent = `本題 +${mvp.points.toLocaleString()} 分`;

      const subMeta = document.createElement('span');
      subMeta.className = 'mvp-banner-meta mono-text';
      const secStr =
        typeof mvp.elapsedMs === 'number' ? `${(mvp.elapsedMs / 1000).toFixed(2)} 秒` : '-';
      subMeta.textContent = `含連勝加成 · 作答 ${secStr}`;

      right.append(ptsStrong, subMeta);
      bannerEl.append(left, right);
    } else if (mvp.status === 'all_wrong') {
      bannerEl.className = 'mvp-spotlight-banner is-all-wrong';
      const msg = document.createElement('strong');
      msg.textContent = `💀 第 ${mvp.questionNumber} 題 單題最高分：從缺（全軍覆沒，本題無人答對）`;
      bannerEl.appendChild(msg);
    } else if (mvp.status === 'no_record') {
      bannerEl.className = 'mvp-spotlight-banner is-no-answers';
      const msg = document.createElement('span');
      msg.textContent = `第 ${mvp.questionNumber} 題 單題最高分：從缺（本題未結算）`;
      bannerEl.appendChild(msg);
    } else if (mvp.status === 'not_played') {
      bannerEl.className = 'mvp-spotlight-banner is-no-answers';
      const msg = document.createElement('span');
      msg.textContent = `第 ${mvp.questionNumber} 題 單題最高分：從缺（本題未進行）`;
      bannerEl.appendChild(msg);
    } else {
      bannerEl.className = 'mvp-spotlight-banner is-no-answers';
      const msg = document.createElement('span');
      msg.textContent = `第 ${mvp.questionNumber} 題 單題最高分：從缺（本題無人作答）`;
      bannerEl.appendChild(msg);
    }
  }

  function renderIndividualLeaderboardDom(
    container,
    list,
    allowKick,
    selfPlayerId = null,
    showQuestionDelta = false
  ) {
    container.textContent = '';
    if (!Array.isArray(list) || list.length === 0) {
      const p = document.createElement('p');
      p.className = 'text-muted';
      p.textContent = '目前尚無排名資料。';
      container.appendChild(p);
      return;
    }

    list.forEach((item) => {
      const isSelf = Boolean(selfPlayerId && item.id === selfPlayerId);
      const isMvpRow = Boolean(showQuestionDelta && item.isQuestionMvp);
      const row = document.createElement('div');
      row.className = `lb-row ${item.rank <= 3 ? `rank-${item.rank}` : ''} ${
        isSelf ? 'is-self' : ''
      } ${isMvpRow ? 'is-question-mvp' : ''}`.trim();

      const left = document.createElement('div');
      left.className = 'lb-left';

      const rankSpan = document.createElement('span');
      rankSpan.className = 'lb-rank mono-text';
      rankSpan.textContent = `#${item.rank}`;

      const nameStrong = document.createElement('strong');
      nameStrong.textContent = item.nickname;

      const grpBadge = document.createElement('span');
      grpBadge.className = 'badge';
      grpBadge.textContent = item.groupName;

      left.append(rankSpan, nameStrong, grpBadge);

      if (isMvpRow) {
        const mvpBadge = document.createElement('span');
        mvpBadge.className = 'badge badge-mvp';
        mvpBadge.textContent = '⚡ 本題最高';
        left.appendChild(mvpBadge);
      }

      if (isSelf) {
        const selfBadge = document.createElement('span');
        selfBadge.className = 'badge badge-info';
        selfBadge.textContent = '你';
        left.appendChild(selfBadge);
      }

      const right = document.createElement('div');
      right.className = 'lb-left';

      if (showQuestionDelta && typeof item.lastQuestionPoints === 'number') {
        const deltaSpan = document.createElement('span');
        deltaSpan.className = `lb-last-points mono-text ${
          item.lastQuestionPoints > 0 ? 'is-positive' : 'is-zero'
        }`;
        deltaSpan.textContent = `本題 +${item.lastQuestionPoints.toLocaleString()}`;
        right.appendChild(deltaSpan);
      }

      const metaSpan = document.createElement('span');
      metaSpan.className = 'text-muted text-sm';
      metaSpan.textContent = `答對 ${item.correctCount} 題`;

      const scoreSpan = document.createElement('span');
      scoreSpan.className = 'lb-score mono-text';
      scoreSpan.textContent = `${item.score.toLocaleString()} 分`;

      right.append(metaSpan, scoreSpan);

      if (allowKick && currentHostPin && hostToken) {
        const menu = document.createElement('details');
        menu.className = 'more-actions-menu';

        const summary = document.createElement('summary');
        summary.className = 'more-actions-summary';
        summary.textContent = '更多操作';

        const dropdown = document.createElement('div');
        dropdown.className = 'more-actions-dropdown';

        const kickBtn = document.createElement('button');
        kickBtn.type = 'button';
        kickBtn.className = 'btn btn-destructive btn-xs';
        kickBtn.textContent = '移除參賽者';
        kickBtn.addEventListener('click', () => {
          menu.open = false;
          openConfirmDialog({
            title: '移除參賽者',
            message: `確定移除「${item.nickname}」嗎？移除後將釋放${item.groupName}的名額。`,
            confirmText: '確定移除',
            isDestructive: true,
            triggerEl: summary,
            onConfirm: () => {
              socket.emit('host:kick_player', {
                pin: currentHostPin,
                playerId: item.id,
                hostToken
              });
            }
          });
        });
        dropdown.appendChild(kickBtn);
        menu.append(summary, dropdown);
        right.appendChild(menu);
      }

      row.append(left, right);
      container.appendChild(row);
    });
  }

  function renderGroupLeaderboardDom(container, groups) {
    container.textContent = '';
    if (!Array.isArray(groups) || groups.length === 0) return;

    groups.forEach((g) => {
      const row = document.createElement('div');
      row.className = `lb-row ${g.rank <= 3 ? `rank-${g.rank}` : ''}`;

      const left = document.createElement('div');
      left.className = 'lb-left';

      const rankSpan = document.createElement('span');
      rankSpan.className = 'lb-rank mono-text';
      rankSpan.textContent = `#${g.rank}`;

      const nameStrong = document.createElement('strong');
      nameStrong.textContent = g.name;

      const countSpan = document.createElement('span');
      countSpan.className = 'text-muted text-sm';
      countSpan.textContent = `${g.memberCount}／${g.maxMembers} 人`;

      left.append(rankSpan, nameStrong, countSpan);

      const right = document.createElement('div');
      right.className = 'lb-score mono-text';
      right.textContent = `平均 ${g.avgScore.toLocaleString()} 分（總分 ${g.totalScore.toLocaleString()}）`;

      row.append(left, right);
      container.appendChild(row);
    });
  }

  function renderPodiumDom(container, top3) {
    container.textContent = '';
    const labels = ['第一名', '第二名', '第三名'];
    top3.forEach((p, idx) => {
      const box = document.createElement('div');
      box.className = `podium-box podium-${idx + 1}`;

      const medal = document.createElement('div');
      medal.className = 'podium-medal';
      medal.textContent = labels[idx] || `第 ${idx + 1} 名`;

      const name = document.createElement('div');
      name.className = 'podium-name';
      name.textContent = p.nickname;

      const grp = document.createElement('div');
      grp.className = 'badge';
      grp.textContent = p.groupName;

      const score = document.createElement('div');
      score.className = 'result-points mono-text';
      score.textContent = `${p.score.toLocaleString()} 分`;

      const detail = document.createElement('div');
      detail.className = 'text-muted text-sm';
      detail.textContent = `答對 ${p.correctCount} 題｜總答題時間 ${(p.totalTimeMs / 1000).toFixed(
        1
      )} 秒`;

      box.append(medal, name, grp, score, detail);
      container.appendChild(box);
    });
  }

  function renderAllQuestionsReviewDom(container, questions) {
    container.textContent = '';
    questions.forEach((q) => {
      const item = document.createElement('div');
      item.className = 'review-item';

      const title = document.createElement('h4');
      title.textContent = `${q.number}. ${q.title}（正確答案：${q.answer}）`;

      const mvp = q.questionMvp;
      let mvpLine = null;
      if (mvp) {
        mvpLine = document.createElement('p');
        if (mvp.status === 'has_winner' && Array.isArray(mvp.winners) && mvp.winners.length > 0) {
          mvpLine.className = 'review-mvp-tag is-winner';
          const secStr =
            typeof mvp.elapsedMs === 'number' ? `${(mvp.elapsedMs / 1000).toFixed(2)} 秒` : '';
          mvpLine.textContent = `👑 本題單題王：${formatMvpWinnerNames(
            mvp.winners
          )}｜+${mvp.points.toLocaleString()} 分${secStr ? `（${secStr}）` : ''}`;
        } else if (mvp.status === 'all_wrong') {
          mvpLine.className = 'review-mvp-tag is-empty';
          mvpLine.textContent = '💀 本題單題王：從缺（全軍覆沒）';
        } else if (mvp.status === 'no_record') {
          mvpLine.className = 'review-mvp-tag is-empty';
          mvpLine.textContent = '本題單題王：從缺（本題未結算）';
        } else if (mvp.status === 'not_played') {
          mvpLine.className = 'review-mvp-tag is-empty';
          mvpLine.textContent = '本題單題王：從缺（本題未進行）';
        } else {
          mvpLine.className = 'review-mvp-tag is-empty';
          mvpLine.textContent = '本題單題王：從缺（本題無人作答）';
        }
      }

      const correctOpt = document.createElement('p');
      correctOpt.className = 'review-correct-opt';
      correctOpt.textContent = `${q.answer}. ${q.options[q.answer] || ''}`;

      const exp = document.createElement('p');
      exp.className = 'text-muted text-sm';
      exp.textContent = `解析：${q.explanation}`;

      if (mvpLine) {
        item.append(title, mvpLine, correctOpt, exp);
      } else {
        item.append(title, correctOpt, exp);
      }
      container.appendChild(item);
    });
  }

  function renderHostAllQuestionsMvpDom(container, questions) {
    if (!container) return;
    container.textContent = '';
    if (!Array.isArray(questions) || questions.length === 0) return;

    questions.forEach((q) => {
      const row = document.createElement('div');
      row.className = 'mvp-summary-row';

      const left = document.createElement('div');
      left.className = 'mvp-summary-left';

      const qBadge = document.createElement('span');
      qBadge.className = 'badge mono-text';
      qBadge.textContent = `Q${q.number}`;

      const qTitle = document.createElement('strong');
      qTitle.textContent = q.title;

      left.append(qBadge, qTitle);

      const right = document.createElement('div');
      right.className = 'mvp-summary-right mono-text';

      const mvp = q.questionMvp;
      if (mvp && mvp.status === 'has_winner' && Array.isArray(mvp.winners) && mvp.winners.length > 0) {
        const winnerSpan = document.createElement('span');
        winnerSpan.className = 'mvp-summary-winner';
        winnerSpan.textContent = `👑 ${formatMvpWinnerNames(mvp.winners)}`;

        const ptsBadge = document.createElement('span');
        ptsBadge.className = 'badge badge-mvp mono-text';
        const secStr =
          typeof mvp.elapsedMs === 'number' ? ` · ${(mvp.elapsedMs / 1000).toFixed(2)}s` : '';
        ptsBadge.textContent = `+${mvp.points.toLocaleString()} 分${secStr}`;

        right.append(winnerSpan, ptsBadge);
      } else if (mvp && mvp.status === 'all_wrong') {
        const emptySpan = document.createElement('span');
        emptySpan.className = 'text-muted text-sm';
        emptySpan.textContent = '💀 全軍覆沒';
        right.appendChild(emptySpan);
      } else if (mvp && mvp.status === 'no_record') {
        const emptySpan = document.createElement('span');
        emptySpan.className = 'text-muted text-sm';
        emptySpan.textContent = '本題未結算';
        right.appendChild(emptySpan);
      } else if (mvp && mvp.status === 'not_played') {
        const emptySpan = document.createElement('span');
        emptySpan.className = 'text-muted text-sm';
        emptySpan.textContent = '本題未進行';
        right.appendChild(emptySpan);
      } else {
        const emptySpan = document.createElement('span');
        emptySpan.className = 'text-muted text-sm';
        emptySpan.textContent = '本題無人作答';
        right.appendChild(emptySpan);
      }

      row.append(left, right);
      container.appendChild(row);
    });
  }

  btnExportCsv.addEventListener('click', () => {
    if (!currentHostState || !Array.isArray(currentHostState.leaderboard)) return;
    const headers = [
      '個人名次',
      '組別代碼',
      '組別名稱',
      '參賽者暱稱',
      '總分',
      '答對題數',
      '總答題秒數'
    ];
    const rows = currentHostState.leaderboard.map((p) => [
      p.rank,
      p.groupCode,
      `"${String(p.groupName).replace(/"/g, '""')}"`,
      `"${String(p.nickname).replace(/"/g, '""')}"`,
      p.score,
      p.correctCount,
      (p.totalTimeMs / 1000).toFixed(2)
    ]);

    const csvContent =
      '\uFEFF' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `CyberQuiz_Scores_${currentHostState.pin}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('已匯出成績 CSV', 'success');
  });

  function startClientCountdown() {
    if (countdownInterval) clearInterval(countdownInterval);

    const updateTick = () => {
      const state = currentHostState || currentPublicState;
      if (!state || state.status !== 'QUESTION_OPEN' || !state.questionEndsAtEpoch) {
        clearInterval(countdownInterval);
        return;
      }

      const estimatedServerNow = Date.now() + serverClockOffsetMs;
      const remainingMs = Math.max(0, state.questionEndsAtEpoch - estimatedServerNow);
      const remainingSec = Math.ceil(remainingMs / 1000);
      const totalMs = (state.timeLimitSec || 25) * 1000;
      const pct = Math.max(0, Math.min(100, (remainingMs / totalMs) * 100));
      const isWarning = remainingSec <= 5;

      playerTimerSec.textContent = String(remainingSec);
      playerTimerBar.style.width = `${pct}%`;
      playerTimerBar.classList.toggle('timer-warning', isWarning);
      if (playerTimerPill) {
        playerTimerPill.classList.toggle('timer-warning', isWarning);
      }

      hostTimerDisplay.textContent = `${remainingSec} 秒`;
      hostTimerBar.style.width = `${pct}%`;
      hostTimerBar.classList.toggle('timer-warning', isWarning);
      if (hostTimerBox) {
        hostTimerBox.classList.toggle('timer-warning', isWarning);
      }
    };

    updateTick();
    countdownInterval = setInterval(updateTick, 100);
  }

  // ==================== 斷線狀態保護與 Socket.IO 事件監聽 ====================

  function updateConnectionInteractivity() {
    const isOnline = socket.connected;
    offlineBanner.classList.toggle('hidden', isOnline);

    [
      btnHostNextQuestion,
      btnHostRevealAnswer,
      btnHostShowLeaderboard,
      btnHostFinishGame,
      btnHostSkipToNext,
      btnReconnectRoom
    ].forEach((btn) => {
      if (btn) btn.disabled = false;
    });

    const isSubmitted = hasSubmittedCurrentQuestion();
    playerOptionsGrid.querySelectorAll('.option-btn').forEach((btn) => {
      btn.disabled = isSubmitted;
    });
  }

  socket.on('server:hello', ({ serverBootId }) => {
    if (!serverBootId) return;
    socketBootId = serverBootId;
    if (!knownServerBootId) {
      knownServerBootId = serverBootId;
    }
  });

  socket.on('connect', () => {
    connStatusBadge.textContent = '已連線';
    connStatusBadge.className = 'status-indicator status-online';
    updateConnectionInteractivity();

    if (isDisplayOnlyMode && currentDisplayPin) {
      subscribeDisplayToRoom(currentDisplayPin);
      return;
    }
    if (playerToken) {
      bindPlayerSocket();
    }
    if (hostToken && currentHostPin && !hostView.classList.contains('hidden')) {
      subscribeHostToRoom(currentHostPin);
    }
  });

  socket.on('disconnect', () => {
    playerSocketBound = false;
    connStatusBadge.textContent = '網路中斷';
    connStatusBadge.className = 'status-indicator status-offline';
    updateConnectionInteractivity();
  });

  function hasPlayerStateChanged(prevPub, nextPub, prevPers, nextPers) {
    if (!prevPub || !prevPers || !nextPub || !nextPers) return true;
    if (prevPub.status !== nextPub.status) return true;
    if (prevPub.currentQuestionIndex !== nextPub.currentQuestionIndex) return true;
    if (prevPub.currentPlayers !== nextPub.currentPlayers) return true;
    if (prevPub.totalQuestions !== nextPub.totalQuestions) return true;
    if (prevPers.score !== nextPers.score) return true;
    if (prevPers.rank !== nextPers.rank) return true;
    if (prevPers.questionIndex !== nextPers.questionIndex) return true;
    if (prevPers.roomStatus !== nextPers.roomStatus) return true;
    if (
      Boolean(prevPers.currentQuestionResult?.submitted) !==
      Boolean(nextPers.currentQuestionResult?.submitted)
    ) {
      return true;
    }
    return false;
  }

  function hasHostStateChanged(prev, next) {
    if (!prev || !next) return true;
    if (prev.pin !== next.pin) return true;
    if (prev.status !== next.status) return true;
    if (prev.currentQuestionIndex !== next.currentQuestionIndex) return true;
    if (prev.currentPlayers !== next.currentPlayers) return true;
    if (prev.answeredCount !== next.answeredCount) return true;
    if (prev.totalQuestions !== next.totalQuestions) return true;
    const prevLb = (prev.leaderboard || [])
      .map((p) => `${p.id}:${p.score}:${p.connected !== false}`)
      .join(',');
    const nextLb = (next.leaderboard || [])
      .map((p) => `${p.id}:${p.score}:${p.connected !== false}`)
      .join(',');
    return prevLb !== nextLb;
  }

  async function syncActiveStateFallback() {
    try {
      if (isDisplayOnlyMode && currentDisplayPin) {
        const res = await fetch(`/api/rooms/${encodeURIComponent(currentDisplayPin)}/state`);
        realignSocketToActiveServer(res.headers.get('X-Server-Boot-Id'));
        if (!res.ok) return;
        const data = await res.json();
        if (data.ok && data.gameState && hasHostStateChanged(currentHostState, data.gameState)) {
          currentHostState = data.gameState;
          if (data.gameState.serverNowEpoch) {
            serverClockOffsetMs = data.gameState.serverNowEpoch - Date.now();
          }
          renderHostScreen();
        }
        return;
      }

      if (playerToken && !playerView.classList.contains('hidden')) {
        if (socket.connected && !playerSocketBound) {
          bindPlayerSocket();
        }
        const res = await fetch('/api/player/state', {
          headers: { Authorization: `Bearer ${playerToken}` }
        });
        realignSocketToActiveServer(res.headers.get('X-Server-Boot-Id'));
        if (res.status === 401 || res.status === 404) {
          const data = await res.json().catch(() => ({}));
          playerSocketBound = false;
          sessionStorage.removeItem('cyberquiz_player_token');
          playerToken = null;
          currentPublicState = null;
          currentPersonalState = null;
          pendingSelectedOption = null;
          lastRenderedQuestionIndex = -999;
          renderPlayerScreen();
          unlockPinForChange();
          if (data?.error) {
            setFieldError(null, joinGeneralError, data.error, false);
          }
          return;
        }
        if (!res.ok) return;
        const data = await res.json();
        if (
          data.ok &&
          data.gameState &&
          data.personal &&
          hasPlayerStateChanged(
            currentPublicState,
            data.gameState,
            currentPersonalState,
            data.personal
          )
        ) {
          currentPublicState = data.gameState;
          currentPersonalState = data.personal;
          if (data.gameState.serverNowEpoch) {
            serverClockOffsetMs = data.gameState.serverNowEpoch - Date.now();
          }
          renderPlayerScreen();
        }
        return;
      }

      if (
        hostToken &&
        currentHostPin &&
        !hostView.classList.contains('hidden') &&
        !hostActiveRoomArea.classList.contains('hidden')
      ) {
        const { res, data, unauthorized } = await fetchHostApi(
          `/api/host/rooms/${encodeURIComponent(currentHostPin)}`
        );
        if (unauthorized || !res.ok || !data.ok || !data.room) return;
        if (hasHostStateChanged(currentHostState, data.room)) {
          currentHostState = data.room;
          if (data.room.serverNowEpoch) {
            serverClockOffsetMs = data.room.serverNowEpoch - Date.now();
          }
          renderHostScreen();
        }
        return;
      }

      if (
        hostToken &&
        !hostView.classList.contains('hidden') &&
        !hostSetupCard.classList.contains('hidden') &&
        hostTabRooms &&
        !hostTabRooms.classList.contains('hidden')
      ) {
        loadActiveRoomsList();
      }
    } catch {
      // background sync ignore network error
    }
  }

  setInterval(syncActiveStateFallback, 2000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      syncActiveStateFallback();
    }
  });

  socket.on('game:state', (state) => {
    currentPublicState = state;
    if (state?.serverNowEpoch) {
      serverClockOffsetMs = state.serverNowEpoch - Date.now();
    }
    if (isDisplayOnlyMode) {
      currentHostState = state;
      renderHostScreen();
      return;
    }
    if (playerToken) {
      renderPlayerScreen();
    }
  });

  socket.on('player:personal', (personal) => {
    if (!personal) return;
    currentPersonalState = personal;
    // 伺服器先送個人狀態、再送公開狀態；若尚未對應同一題，等 game:state 抵達時再一起渲染
    if (!currentPublicState || isPersonalStateSynced()) {
      renderPlayerScreen();
    }
  });

  socket.on('player:kicked', (data) => {
    sessionStorage.removeItem('cyberquiz_player_token');
    playerToken = null;
    currentPublicState = null;
    currentPersonalState = null;
    pendingSelectedOption = null;
    lastRenderedQuestionIndex = -999;
    renderPlayerScreen();
    unlockPinForChange();
    setFieldError(null, joinGeneralError, data?.message || '你已被主持人移出房間。', false);
  });

  socket.on('room:deleted', (data) => {
    const deletedPin = data?.pin;
    if (isDisplayOnlyMode && (!deletedPin || currentDisplayPin === deletedPin)) {
      currentHostState = null;
      showToast(data?.message || '此房間已被主持人刪除', 'info');
      return;
    }
    if (playerToken) {
      sessionStorage.removeItem('cyberquiz_player_token');
      playerToken = null;
      currentPublicState = null;
      currentPersonalState = null;
      pendingSelectedOption = null;
      lastRenderedQuestionIndex = -999;
      renderPlayerScreen();
      unlockPinForChange();
      setFieldError(
        null,
        joinGeneralError,
        data?.message || '此測驗房間已被主持人刪除或關閉。',
        false
      );
      return;
    }
    if (
      hostToken &&
      deletedPin &&
      (currentHostPin === deletedPin || currentHostState?.pin === deletedPin)
    ) {
      currentHostPin = null;
      currentHostState = null;
      sessionStorage.removeItem('cyberquiz_host_pin');
      openHostSetupScreen();
      showToast(data?.message || `房間 ${deletedPin} 已被刪除`, 'info');
    }
  });

  socket.on('host:state', (state) => {
    currentHostState = state;
    if (state?.serverNowEpoch) {
      serverClockOffsetMs = state.serverNowEpoch - Date.now();
    }
    renderHostScreen();
  });

  socket.on('game:answer_count', ({ answeredCount, totalPlayers }) => {
    if (currentHostState) {
      currentHostState.answeredCount = answeredCount;
      currentHostState.currentPlayers = totalPlayers;
      hostAnsweredCounter.textContent = `${answeredCount}／${totalPlayers}`;
    }
  });

  // ==================== 現場背景音樂 (BGM) 控制模組 ====================

  const BUILTIN_BGM_TRACKS = [
    {
      id: '01-tense-match-25s',
      fileName: '01-tense-match-25s.mp3',
      title: '01. 25秒緊張比賽音樂 (25s)',
      src: '/bgm/01-tense-match-25s.mp3'
    },
    {
      id: '02-extreme-countdown-25s',
      fileName: '02-extreme-countdown-25s.mp3',
      title: '02. 極限緊張倒數 (25s)',
      src: '/bgm/02-extreme-countdown-25s.mp3'
    },
    {
      id: '03-industrial-beat-25s',
      fileName: '03-industrial-beat-25s.mp3',
      title: '03. 工業重拍窒息 (25s)',
      src: '/bgm/03-industrial-beat-25s.mp3'
    },
    {
      id: '04-dark-hero-25s',
      fileName: '04-dark-hero-25s.mp3',
      title: '04. 黑化主角登場 (25s)',
      src: '/bgm/04-dark-hero-25s.mp3'
    },
    {
      id: '05-villain-aura-25s',
      fileName: '05-villain-aura-25s.mp3',
      title: '05. 反派氣場 (25s)',
      src: '/bgm/05-villain-aura-25s.mp3'
    },
    {
      id: '06-sudden-awakening-25s',
      fileName: '06-sudden-awakening-25s.mp3',
      title: '06. 突發黑化覺醒 (25s)',
      src: '/bgm/06-sudden-awakening-25s.mp3'
    },
    {
      id: '07-dark-turning-point-25s',
      fileName: '07-dark-turning-point-25s.mp3',
      title: '07. 黑化轉折點 (25s)',
      src: '/bgm/07-dark-turning-point-25s.mp3'
    },
    {
      id: '08-despair-suppression-25s',
      fileName: '08-despair-suppression-25s.mp3',
      title: '08. 處刑曲・絕望壓制 (25s)',
      src: '/bgm/08-despair-suppression-25s.mp3'
    },
    {
      id: '09-medieval-fantasy-25s',
      fileName: '09-medieval-fantasy-25s.mp3',
      title: '09. 中古奇幻・處刑曲 (25s)',
      src: '/bgm/09-medieval-fantasy-25s.mp3'
    },
    {
      id: '10-execution-ignite-25s',
      fileName: '10-execution-ignite-25s.mp3',
      title: '10. 處刑時刻・燃爆 (25s)',
      src: '/bgm/10-execution-ignite-25s.mp3'
    },
    {
      id: '11-crusade-execution-25s',
      fileName: '11-crusade-execution-25s.mp3',
      title: '11. 聖戰處刑 (25s)',
      src: '/bgm/11-crusade-execution-25s.mp3'
    },
    {
      id: '12-irish-awakening-25s',
      fileName: '12-irish-awakening-25s.mp3',
      title: '12. 愛爾蘭黑化覺醒 (25s)',
      src: '/bgm/12-irish-awakening-25s.mp3'
    },
    {
      id: '13-celtic-war-soul-25s',
      fileName: '13-celtic-war-soul-25s.mp3',
      title: '13. 凱爾特戰魂處刑 (25s)',
      src: '/bgm/13-celtic-war-soul-25s.mp3'
    },
    {
      id: '14-celtic-dream-flight-25s',
      fileName: '14-celtic-dream-flight-25s.mp3',
      title: '14. 夢的起飛・凱爾特奇幻 (25s)',
      src: '/bgm/14-celtic-dream-flight-25s.mp3'
    },
    {
      id: '15-wings-of-adventure-25s',
      fileName: '15-wings-of-adventure-25s.mp3',
      title: '15. 夢的翅膀・冒險開始 (25s)',
      src: '/bgm/15-wings-of-adventure-25s.mp3'
    },
    {
      id: '16-egyptian-odyssey-25s',
      fileName: '16-egyptian-odyssey-25s.mp3',
      title: '16. 埃及神話・啟程 (25s)',
      src: '/bgm/16-egyptian-odyssey-25s.mp3'
    },
    {
      id: '17-ten-thousand-swords-25s',
      fileName: '17-ten-thousand-swords-25s.mp3',
      title: '17. 修仙絕技・萬劍歸宗 (25s)',
      src: '/bgm/17-ten-thousand-swords-25s.mp3'
    },
    {
      id: '18-tribulation-burst-25s',
      fileName: '18-tribulation-burst-25s.mp3',
      title: '18. 渡劫爆發・靈力全開 (25s)',
      src: '/bgm/18-tribulation-burst-25s.mp3'
    }
  ];

  const bgmTracks = [...BUILTIN_BGM_TRACKS];
  const bgmAudio = new Audio();
  bgmAudio.preload = 'none';
  let isBgmEnabled = false;
  let currentBgmMode = 'sequential'; // 'sequential' | 'random' | track.id
  let currentBgmTrackIndex = 0;
  let lastBgmRoomPin = null;
  let lastBgmQuestionIndex = -999;
  let lastBgmStageStatus = null;
  let currentBgmStageMultiplier = 1.0; // 作答時 1.0，揭曉與排行榜時自動降為 0.35 方便主持人講解
  const usedBgmTrackIndices = new Set();

  const savedVolume = parseInt(localStorage.getItem('cyberquiz_bgm_volume') || '45', 10);
  let userBgmVolumePercent = Number.isFinite(savedVolume)
    ? Math.max(0, Math.min(100, savedVolume))
    : 45;
  if (inputBgmVolume) {
    inputBgmVolume.value = String(userBgmVolumePercent);
  }

  function applyEffectiveBgmVolume(multiplier = currentBgmStageMultiplier) {
    currentBgmStageMultiplier = multiplier;
    const rawVol = (userBgmVolumePercent / 100) * currentBgmStageMultiplier;
    bgmAudio.volume = Math.max(0, Math.min(1, rawVol));
  }
  applyEffectiveBgmVolume(1.0);

  function populateBgmSelects() {
    const trackCount = bgmTracks.length;
    if (setupBgmMode) {
      const prevSetup = setupBgmMode.value || 'off';
      setupBgmMode.textContent = '';
      const baseSetupOpts = [
        { value: 'off', label: '預設關閉（進入房間後可隨時一鍵開啟 BGM）' },
        { value: 'sequential', label: `自動播放：每題依序換一首 25 秒戰歌（共 ${trackCount} 首）` },
        { value: 'random', label: `自動播放：每題隨機換一首 25 秒戰歌（${trackCount} 首不重複）` }
      ];
      baseSetupOpts.forEach((o) => {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        setupBgmMode.appendChild(opt);
      });
      bgmTracks.forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = `自指定曲目起播（每題換歌）：${t.title}`;
        setupBgmMode.appendChild(opt);
      });
      setupBgmMode.value = prevSetup;
    }

    if (selectHostBgmTrack) {
      const prevHost = selectHostBgmTrack.value || currentBgmMode || 'sequential';
      selectHostBgmTrack.textContent = '';
      const modeOpts = [
        { value: 'sequential', label: `每題依序換歌（共 ${trackCount} 首 25s 戰歌）` },
        { value: 'random', label: `每題隨機換歌（${trackCount} 首不重複）` }
      ];
      modeOpts.forEach((o) => {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        selectHostBgmTrack.appendChild(opt);
      });
      bgmTracks.forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.title;
        selectHostBgmTrack.appendChild(opt);
      });
      const uploadOpt = document.createElement('option');
      uploadOpt.value = '__upload_custom__';
      uploadOpt.textContent = '+ 載入本機自訂音樂檔 (MP3/M4A)…';
      selectHostBgmTrack.appendChild(uploadOpt);
      selectHostBgmTrack.value = prevHost === '__upload_custom__' ? 'sequential' : prevHost;
    }
  }

  async function syncBgmTracksFromServer() {
    try {
      const res = await fetch('/api/bgm');
      if (!res.ok) return;
      const data = await res.json();
      if (!data.ok || !Array.isArray(data.tracks) || data.tracks.length === 0) return;
      const customTracks = bgmTracks.filter((t) => String(t.id).startsWith('custom-'));
      // 保留 BUILTIN 預設排序，若目錄有額外新檔案則自動併入
      const knownFiles = new Set(BUILTIN_BGM_TRACKS.map((t) => t.fileName));
      const extraServerTracks = data.tracks.filter((t) => t.fileName && !knownFiles.has(t.fileName));
      const availableServerFiles = new Set(data.tracks.map((t) => t.fileName));
      const activeBuiltins = BUILTIN_BGM_TRACKS.filter(
        (t) => !t.fileName || availableServerFiles.has(t.fileName)
      );
      const merged = [...activeBuiltins, ...extraServerTracks, ...customTracks];
      if (merged.length > 0) {
        bgmTracks.splice(0, bgmTracks.length, ...merged);
        populateBgmSelects();
      }
    } catch {
      // 離線或靜態環境維持內建清單
    }
  }

  function updateBgmControlUI() {
    if (!btnToggleBgm) return;
    const activeTrack = bgmTracks[currentBgmTrackIndex];
    if (isBgmEnabled) {
      btnToggleBgm.classList.add('bgm-playing');
      btnToggleBgm.textContent = activeTrack ? `播放中：${activeTrack.title}` : 'BGM 播放中';
    } else {
      btnToggleBgm.classList.remove('bgm-playing');
      btnToggleBgm.textContent = '開啟 BGM';
    }
  }

  function pickUnplayedRandomTrackIndex() {
    if (bgmTracks.length <= 1) return 0;
    if (usedBgmTrackIndices.size >= bgmTracks.length) {
      usedBgmTrackIndices.clear();
    }
    const candidates = [];
    for (let i = 0; i < bgmTracks.length; i++) {
      if (!usedBgmTrackIndices.has(i) && i !== currentBgmTrackIndex) {
        candidates.push(i);
      }
    }
    const pool =
      candidates.length > 0
        ? candidates
        : bgmTracks.map((_, i) => i).filter((i) => i !== currentBgmTrackIndex);
    const chosen = pool[Math.floor(Math.random() * pool.length)] || 0;
    usedBgmTrackIndices.add(chosen);
    return chosen;
  }

  function pickTrackIndexForMode(mode, advanceNext = false, questionIdx = null) {
    if (bgmTracks.length === 0) return 0;
    const exactIdx = bgmTracks.findIndex((t) => t.id === mode);
    if (exactIdx !== -1) {
      if (advanceNext) {
        return (currentBgmTrackIndex + 1) % bgmTracks.length;
      }
      return exactIdx;
    }
    if (mode === 'random') {
      return pickUnplayedRandomTrackIndex();
    }
    // sequential（依題號或下一首切換）
    if (typeof questionIdx === 'number' && questionIdx >= 0) {
      let target = questionIdx % bgmTracks.length;
      if (advanceNext && target === currentBgmTrackIndex && bgmTracks.length > 1) {
        target = (currentBgmTrackIndex + 1) % bgmTracks.length;
      }
      return target;
    }
    if (advanceNext) {
      return (currentBgmTrackIndex + 1) % bgmTracks.length;
    }
    return currentBgmTrackIndex % bgmTracks.length;
  }

  function playTrackAtIndex(idx) {
    if (bgmTracks.length === 0) return;
    currentBgmTrackIndex = ((idx % bgmTracks.length) + bgmTracks.length) % bgmTracks.length;
    usedBgmTrackIndices.add(currentBgmTrackIndex);
    const track = bgmTracks[currentBgmTrackIndex];
    if (!track) return;

    const targetHref = new URL(track.src, window.location.origin).href;
    if (bgmAudio.src !== targetHref) {
      bgmAudio.src = track.src;
    } else {
      bgmAudio.currentTime = 0;
    }
    // 單一題目時間內若音樂播完則自動無縫循環該首，換下一題時由 syncBgmWithHostStage 自動切換新曲目並從 0 秒對齊 25 秒倒數
    bgmAudio.loop = true;
    if (
      selectHostBgmTrack &&
      currentBgmMode !== 'random' &&
      currentBgmMode !== 'sequential'
    ) {
      currentBgmMode = track.id;
      selectHostBgmTrack.value = track.id;
    }
    updateBgmControlUI();
    bgmAudio
      .play()
      .then(updateBgmControlUI)
      .catch(() => {
        isBgmEnabled = false;
        updateBgmControlUI();
        showToast('請點擊「開啟 BGM」以允許瀏覽器播放音樂', 'info');
      });
  }

  function startBgmPlayback(modeOverride = null, advanceNext = false) {
    if (modeOverride && modeOverride !== '__upload_custom__') {
      currentBgmMode = modeOverride;
    }
    isBgmEnabled = true;
    const stageStatus = currentHostState?.status || 'LOBBY';
    const isRevealOrBoard =
      stageStatus === 'QUESTION_REVEAL' ||
      stageStatus === 'LEADERBOARD' ||
      stageStatus === 'FINISHED';
    applyEffectiveBgmVolume(isRevealOrBoard ? 0.35 : 1.0);

    const activeQIdx =
      stageStatus === 'QUESTION_OPEN' ||
      stageStatus === 'QUESTION_REVEAL' ||
      stageStatus === 'LEADERBOARD'
        ? currentHostState.currentQuestionIndex
        : null;
    if (typeof activeQIdx === 'number' && activeQIdx >= 0) {
      lastBgmQuestionIndex = activeQIdx;
    } else if (stageStatus === 'LOBBY') {
      lastBgmQuestionIndex = -1;
    }
    lastBgmStageStatus = stageStatus;
    const nextIdx = pickTrackIndexForMode(currentBgmMode, advanceNext, activeQIdx);
    playTrackAtIndex(nextIdx);
  }

  /**
   * 根據房間階段自動調控 BGM：
   * 1. 當進入新題目（QUESTION_OPEN 且題號改變）時，恢復 100% 設定音量並自動換播下一首 25 秒戰歌（從 0 秒開始精準貼合 25 秒倒數）
   * 2. 當進入公布答案／排行榜（QUESTION_REVEAL / LEADERBOARD / FINISHED）時，自動將音樂柔化降至 35%，讓主持人講解清晰不刺耳
   */
  function syncBgmWithHostStage(st) {
    if (!st) return;
    if (st.pin !== lastBgmRoomPin) {
      lastBgmRoomPin = st.pin;
      lastBgmQuestionIndex = st.status === 'LOBBY' ? -1 : st.currentQuestionIndex;
      lastBgmStageStatus = st.status;
      usedBgmTrackIndices.clear();
      return;
    }
    if (st.status === 'LOBBY') {
      lastBgmQuestionIndex = -1;
      lastBgmStageStatus = 'LOBBY';
      applyEffectiveBgmVolume(0.75);
      return;
    }

    // 階段音量智慧閃避（Ducking）：作答期間 100% 燃爆倒數，公佈答案與排行榜時降為 35% 襯底
    if (st.status !== lastBgmStageStatus) {
      lastBgmStageStatus = st.status;
      if (st.status === 'QUESTION_OPEN') {
        applyEffectiveBgmVolume(1.0);
      } else if (
        st.status === 'QUESTION_REVEAL' ||
        st.status === 'LEADERBOARD' ||
        st.status === 'FINISHED'
      ) {
        applyEffectiveBgmVolume(0.35);
      }
    }

    if (
      typeof st.currentQuestionIndex === 'number' &&
      st.currentQuestionIndex >= 0 &&
      st.currentQuestionIndex !== lastBgmQuestionIndex
    ) {
      lastBgmQuestionIndex = st.currentQuestionIndex;
      if (!isBgmEnabled) return;
      applyEffectiveBgmVolume(st.status === 'QUESTION_OPEN' ? 1.0 : 0.35);
      let nextIdx;
      if (currentBgmMode === 'random') {
        nextIdx = pickUnplayedRandomTrackIndex();
      } else {
        nextIdx = (currentBgmTrackIndex + 1) % bgmTracks.length;
      }
      playTrackAtIndex(nextIdx);
    }
  }

  function stopBgmPlayback() {
    isBgmEnabled = false;
    bgmAudio.pause();
    updateBgmControlUI();
  }

  bgmAudio.addEventListener('ended', () => {
    if (!isBgmEnabled) return;
    if (currentBgmMode === 'random' || currentBgmMode === 'sequential') {
      startBgmPlayback(currentBgmMode, true);
    } else {
      bgmAudio.currentTime = 0;
      bgmAudio.play().catch(() => {});
    }
  });

  bgmAudio.addEventListener('play', updateBgmControlUI);
  bgmAudio.addEventListener('pause', updateBgmControlUI);

  if (btnToggleBgm) {
    btnToggleBgm.addEventListener('click', () => {
      if (isBgmEnabled && !bgmAudio.paused) {
        stopBgmPlayback();
      } else {
        const selected = selectHostBgmTrack?.value || currentBgmMode || 'random';
        startBgmPlayback(selected);
      }
    });
  }

  if (selectHostBgmTrack) {
    selectHostBgmTrack.addEventListener('change', () => {
      const val = selectHostBgmTrack.value;
      if (val === '__upload_custom__') {
        selectHostBgmTrack.value = currentBgmMode;
        if (inputCustomBgmFile) inputCustomBgmFile.click();
        return;
      }
      currentBgmMode = val;
      if (isBgmEnabled) {
        startBgmPlayback(val, false);
      }
    });
  }

  if (btnNextBgmTrack) {
    btnNextBgmTrack.addEventListener('click', () => {
      if (currentBgmMode !== 'random' && currentBgmMode !== 'sequential') {
        const nextIdx = (currentBgmTrackIndex + 1) % bgmTracks.length;
        currentBgmMode = bgmTracks[nextIdx].id;
        if (selectHostBgmTrack) {
          selectHostBgmTrack.value = currentBgmMode;
        }
        startBgmPlayback(currentBgmMode, false);
      } else {
        startBgmPlayback(currentBgmMode, true);
      }
    });
  }

  if (inputBgmVolume) {
    inputBgmVolume.addEventListener('input', () => {
      userBgmVolumePercent = Math.max(0, Math.min(100, parseInt(inputBgmVolume.value, 10) || 0));
      applyEffectiveBgmVolume(currentBgmStageMultiplier);
      localStorage.setItem('cyberquiz_bgm_volume', String(userBgmVolumePercent));
    });
  }

  if (inputCustomBgmFile) {
    inputCustomBgmFile.addEventListener('change', () => {
      const files = Array.from(inputCustomBgmFile.files || []);
      if (files.length === 0) return;
      let firstAddedId = null;
      files.forEach((file) => {
        const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const cleanName = file.name.replace(/\.[^.]+$/, '');
        const blobUrl = URL.createObjectURL(file);
        bgmTracks.push({
          id,
          title: `自訂：${cleanName}`,
          src: blobUrl
        });
        if (!firstAddedId) firstAddedId = id;
      });
      populateBgmSelects();
      if (firstAddedId) {
        currentBgmMode = firstAddedId;
        if (selectHostBgmTrack) selectHostBgmTrack.value = firstAddedId;
        startBgmPlayback(firstAddedId, false);
        showToast(`已載入並播放自訂音樂（共新增 ${files.length} 首）`, 'success');
      }
      inputCustomBgmFile.value = '';
    });
  }

  populateBgmSelects();
  syncBgmTracksFromServer();

  // ==================== 啟動路由初始化 ====================

  const urlParams = new URLSearchParams(window.location.search);
  const queryPin = urlParams.get('pin');
  const queryGroup = urlParams.get('group');
  const pathname = window.location.pathname;

  if (pathname.startsWith('/display')) {
    const pathParts = pathname.split('/').filter(Boolean);
    const displayPin = pathParts[1] || queryPin;
    if (displayPin && /^\d{6}$/.test(displayPin)) {
      currentDisplayPin = displayPin;
      showMode('display');
    } else {
      showMode('host');
    }
  } else if (pathname === '/host') {
    showMode('host');
  } else {
    showMode('player');
    if (playerToken) {
      bindPlayerSocket();
    } else if (queryPin && /^\d{6}$/.test(queryPin)) {
      inputRoomPin.value = queryPin;
      lookupRoomByPin(queryPin, queryGroup);
    }
  }
})();
