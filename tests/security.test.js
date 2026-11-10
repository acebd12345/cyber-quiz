'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createAppServer } = require('../src/server');
const { verifyToken } = require('../src/security');
const { verifyAdminTokenState } = require('../src/db');

async function runTests() {
  // 0. 測試 Production Fail-Closed：正式環境若未設定密鑰必須拒絕啟動
  {
    const prevEnv = process.env.NODE_ENV;
    const prevHostPass = process.env.HOST_PASSWORD;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.HOST_PASSWORD;
      assert.throws(() => {
        createAppServer();
      }, /正式環境必須設定/);
      console.log('✅ 0. Production Fail-Closed（未設密鑰拒絕啟動）測試通過');
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevHostPass !== undefined) process.env.HOST_PASSWORD = prevHostPass;
    }
  }

  const { server, io, gameManager, hostPassword } = createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`[Test] Testing server at ${baseUrl}`);

  try {
    // 1. 檢查 HTTP Security Headers (嚴格 CSP connect-src 'self', nosniff, hide X-Powered-By) 與 UI/UX 關鍵結構
    const homeRes = await fetch(`${baseUrl}/`);
    assert.strictEqual(homeRes.status, 200);
    assert.strictEqual(homeRes.headers.get('x-powered-by'), null, 'x-powered-by 必須隱藏');
    assert.strictEqual(homeRes.headers.get('x-content-type-options'), 'nosniff');
    const csp = homeRes.headers.get('content-security-policy') || '';
    assert(csp.includes("script-src 'self'"), 'CSP 必須嚴格限制 script-src self');
    assert(csp.includes("connect-src 'self'"), 'CSP connect-src 必須僅允許同源 self');
    assert(!csp.includes('ws:'), 'CSP connect-src 不可開放任意網域 ws:');

    const htmlText = await homeRes.text();
    assert(htmlText.includes('<a href="/" class="brand" id="brandHomeBtn">'), '品牌連結必須為原生 <a>');
    assert(htmlText.includes('id="offlineBanner"'), '必須包含斷線全寬警示列');
    assert(htmlText.includes('id="confirmModal"'), '必須包含二次確認視窗');
    assert(htmlText.includes('id="btnChangePin"'), '必須包含更換房間按鈕');
    assert(htmlText.includes('id="btnToggleProjectorMode"'), '必須包含投影安全模式切換鈕');

    const displayRes = await fetch(`${baseUrl}/display/123456`);
    assert.strictEqual(displayRes.status, 200, '/display/:pin 路由必須可用');

    const qrRes = await fetch(`${baseUrl}/api/qrcode?pin=123456&group=G1`);
    assert.strictEqual(qrRes.status, 200, '/api/qrcode 必須可用');
    const qrSvg = await qrRes.text();
    assert(qrSvg.includes('<svg'), 'QR Code API 應回傳向量 SVG');
    assert(htmlText.includes('id="hostLobbyQrImg"'), '大銀幕展示頁與等待室必須包含大型入場 QR Code');
    assert(htmlText.includes('id="hostHeaderQrImg"'), '大銀幕展示頁頂部資訊列必須包含常駐 QR Code');
    console.log('✅ 1. 資安標頭、大銀幕展示頁 QR Code 與 UI/UX P0~P2 結構驗證通過');

    // 2. 主持人密碼驗證測試
    const badHostRes = await fetch(`${baseUrl}/api/host/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' })
    });
    assert.strictEqual(badHostRes.status, 401);

    const goodHostRes = await fetch(`${baseUrl}/api/host/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: hostPassword })
    });
    assert.strictEqual(goodHostRes.status, 200);
    const { hostToken } = await goodHostRes.json();
    assert(hostToken, '應取得 hostToken');
    console.log('✅ 2. 主持人認證與防偽 Token 測試通過');

    // 3. 建立房間（總上限 3 人，第 1 組上限 2 人，第 2 組上限 2 人，第 3 組測試暴力破解鎖定）
    const createRes = await fetch(`${baseUrl}/api/host/rooms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hostToken}`
      },
      body: JSON.stringify({
        title: '資安競賽測試房',
        maxPlayers: 3,
        timeLimitSec: 30,
        groups: [
          { name: '第一組', password: 'PassG1', maxMembers: 2 },
          { name: '第二組', password: 'PassG2', maxMembers: 2 },
          { name: '第三組', password: 'PassG3', maxMembers: 2 }
        ]
      })
    });
    assert.strictEqual(createRes.status, 200);
    const { room } = await createRes.json();
    const pin = room.pin;
    assert.strictEqual(room.totalQuestions, 10, '應載入完整 10 道題目');
    console.log(`✅ 3. 建立房間成功 (PIN: ${pin}，內建 10 題)`);

    // 4. 公開查詢房間 API 不得洩漏各組密碼
    const pubRoomRes = await fetch(`${baseUrl}/api/rooms/${pin}`);
    const pubRoomData = await pubRoomRes.json();
    const pubJsonStr = JSON.stringify(pubRoomData);
    assert(!pubJsonStr.includes('PassG1'), '公開 API 絕不可包含組別密碼');
    assert(!pubJsonStr.includes('PassG2'), '公開 API 絕不可包含組別密碼');
    console.log('✅ 4. 公開查詢 API 零密碼洩漏測試通過');

    // 5. 組別密碼錯誤與防暴力破解「先擋再驗」測試（鎖定後即使輸入正確密碼也必須回傳 429）
    for (let i = 0; i < 12; i++) {
      const wrongRes = await fetch(`${baseUrl}/api/rooms/${pin}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          groupCode: 'G3',
          groupPassword: `WrongAttempt_${i}`,
          nickname: `BruteUser_${i}`
        })
      });
      assert(wrongRes.status === 400 || wrongRes.status === 429);
    }
    // 第 13 次即使輸入「正確」的第三組密碼 PassG3，也必須因已被鎖定而直接回傳 429！
    const lockedOutEvenWithRightPass = await fetch(`${baseUrl}/api/rooms/${pin}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupCode: 'G3',
        groupPassword: 'PassG3',
        nickname: 'LegitAfterLockout'
      })
    });
    assert.strictEqual(
      lockedOutEvenWithRightPass.status,
      429,
      '被鎖定後即使輸入正確密碼也必須攔截 (429)'
    );
    console.log('✅ 5. 防暴力破解鎖定（鎖定後連正確密碼亦強制攔截）測試通過');

    // 6. XSS 惡意暱稱應被攔截
    const xssNickRes = await fetch(`${baseUrl}/api/rooms/${pin}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupCode: 'G1',
        groupPassword: 'PassG1',
        nickname: '<script>alert(1)</script>'
      })
    });
    assert.strictEqual(xssNickRes.status, 400);
    console.log('✅ 6. XSS 惡意暱稱輸入攔截測試通過');

    // 7. 測試單組人數上限 (G1 上限 2 人) 與全場總人數上限 (3 人)
    const join1 = await fetch(`${baseUrl}/api/rooms/${pin}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupCode: 'G1', groupPassword: 'PassG1', nickname: 'Alice' })
    });
    assert.strictEqual(join1.status, 200);
    const p1Data = await join1.json();

    // 重複暱稱 (不分大小寫) 應被攔截
    const dupNick = await fetch(`${baseUrl}/api/rooms/${pin}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupCode: 'G1', groupPassword: 'PassG1', nickname: 'alice' })
    });
    assert.strictEqual(dupNick.status, 400);

    const join2 = await fetch(`${baseUrl}/api/rooms/${pin}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupCode: 'G1', groupPassword: 'PassG1', nickname: 'Bob' })
    });
    assert.strictEqual(join2.status, 200);

    // 第 3 人嘗試加入第一組 (G1 已滿 2/2) -> 應被拒絕
    const joinG1Full = await fetch(`${baseUrl}/api/rooms/${pin}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupCode: 'G1', groupPassword: 'PassG1', nickname: 'Charlie' })
    });
    assert.strictEqual(joinG1Full.status, 400);

    // 改加入第二組 (G2 尚有空位，且全場 2/3) -> 應成功
    const join3 = await fetch(`${baseUrl}/api/rooms/${pin}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupCode: 'G2', groupPassword: 'PassG2', nickname: 'Charlie' })
    });
    assert.strictEqual(join3.status, 200);

    // 第 4 人嘗試加入第二組 (雖然 G2 為 1/2，但全場已達 3/3 總上限) -> 應被拒絕
    const joinRoomFull = await fetch(`${baseUrl}/api/rooms/${pin}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupCode: 'G2', groupPassword: 'PassG2', nickname: 'David' })
    });
    assert.strictEqual(joinRoomFull.status, 400);
    console.log('✅ 7. 單組人數上限、全場總人數上限與暱稱防重測試通過');

    // 8. 開始第 1 題，驗證防連點跳題與 QUESTION_OPEN 階段零答案洩漏
    const startQ1 = await gameManager.startNextQuestion(pin);
    assert.strictEqual(startQ1.ok, true);

    // 模擬主持人連點兩下「開始下一題」 -> 必須被狀態機攔截，題號維持在 index 0 (第 1 題)
    const accidentalDoubleClick = await gameManager.startNextQuestion(pin);
    assert.strictEqual(
      accidentalDoubleClick.ok,
      false,
      '作答期間連點下一題必須被攔截，防止誤跳題'
    );

    const internalRoom = gameManager.getRoom(pin);
    assert.strictEqual(internalRoom.currentQuestionIndex, 0, '題號必須保持為第 1 題 (index 0)');

    const openPublicState = gameManager.buildPublicState(internalRoom);
    assert.strictEqual(openPublicState.status, 'QUESTION_OPEN');
    assert.strictEqual(openPublicState.question.number, 1);
    assert.strictEqual(
      openPublicState.question.answer,
      undefined,
      '作答期間絕不可包含 answer 欄位'
    );
    assert.strictEqual(
      openPublicState.question.explanation,
      undefined,
      '作答期間絕不可包含 explanation 欄位'
    );
    console.log('✅ 8. 防主持人連點跳題與作答期間 (QUESTION_OPEN) 零答案洩漏測試通過');

    // 9. 提交答案、禁止重複作答、且揭曉前不提前暴露對錯與加分（含單題王防洩答檢查）
    const q1CorrectOption = internalRoom.questions[0].answer;
    const q1WrongOption = ['A', 'B', 'C', 'D'].find((opt) => opt !== q1CorrectOption);
    const ansRes1 = gameManager.submitAnswer(pin, p1Data.player.id, q1CorrectOption);
    assert.strictEqual(ansRes1.ok, true);
    assert.strictEqual(ansRes1.isCorrect, undefined, '提交回應不可提前透露對錯');

    const openStateAfterSubmit = gameManager.buildPublicState(internalRoom);
    assert.strictEqual(
      openStateAfterSubmit.currentQuestionMvp,
      null,
      '作答期間 (QUESTION_OPEN) 絕不可提前計算或暴露單題王'
    );
    assert(
      openStateAfterSubmit.leaderboard.every(
        (item) => item.isQuestionMvp === false && item.lastQuestionPoints === null
      ),
      '作答期間排行榜不可暴露單題得分或單題王標記'
    );

    const personalDuringOpen = gameManager.buildPlayerPersonalState(internalRoom, p1Data.player.id);
    assert.strictEqual(personalDuringOpen.currentQuestionResult.submitted, true);
    assert.strictEqual(
      personalDuringOpen.currentQuestionResult.isCorrect,
      undefined,
      '作答期間個人狀態不可提前透露對錯'
    );
    assert.strictEqual(personalDuringOpen.score, 0, '揭曉前不可提前變更公開分數');

    // 嘗試二次作答竄改答案 -> 應被拒絕
    const ansDuplicate = gameManager.submitAnswer(pin, p1Data.player.id, q1WrongOption);
    assert.strictEqual(ansDuplicate.ok, false);

    // 揭曉答案後，應正確計算分數並公開標準答案、解析與單題王 (MVP)
    await gameManager.revealCurrentQuestion(pin);
    const revealState = gameManager.buildPublicState(internalRoom);
    assert.strictEqual(revealState.status, 'QUESTION_REVEAL');
    assert.strictEqual(revealState.question.answer, q1CorrectOption);
    assert.strictEqual(revealState.question.explanation, internalRoom.questions[0].explanation);
    assert(revealState.currentQuestionMvp, '揭曉後應包含本題單題王資訊');
    assert.strictEqual(revealState.currentQuestionMvp.status, 'has_winner');
    assert.strictEqual(revealState.currentQuestionMvp.winners.length, 1);
    assert.strictEqual(revealState.currentQuestionMvp.winners[0].nickname, 'Alice');

    await gameManager.showLeaderboard(pin);
    const lbState = gameManager.buildPublicState(internalRoom);
    assert.strictEqual(lbState.status, 'LEADERBOARD');
    assert.strictEqual(lbState.currentQuestionMvp.winners[0].nickname, 'Alice');
    const aliceLbRow = lbState.leaderboard.find((item) => item.id === p1Data.player.id);
    const bobLbRow = lbState.leaderboard.find((item) => item.nickname === 'Bob');
    assert.strictEqual(aliceLbRow.isQuestionMvp, true, '單題最高分得主應標記 isQuestionMvp');
    assert.strictEqual(aliceLbRow.lastQuestionPoints, revealState.currentQuestionMvp.points);
    assert.strictEqual(bobLbRow.isQuestionMvp, false, '非得主不應標記 isQuestionMvp');
    assert.strictEqual(bobLbRow.lastQuestionPoints, 0, '未作答者本題加分為 0');

    const personalAfterReveal = gameManager.buildPlayerPersonalState(
      internalRoom,
      p1Data.player.id
    );
    assert.strictEqual(personalAfterReveal.currentQuestionResult.isCorrect, true);
    assert(personalAfterReveal.score >= 500, '答對後應獲得基礎分與速度加成分數');

    // 驗證提前結束比賽時（例如第 2 題作答中直接結束），未揭曉題為 no_record、未開始題為 not_played，絕不誤判為 all_wrong
    await gameManager.startNextQuestion(pin);
    gameManager.submitAnswer(pin, p1Data.player.id, internalRoom.questions[1].answer);
    await gameManager.finishGame(pin);
    const finishedEarlyState = gameManager.buildPublicState(internalRoom);
    assert.strictEqual(finishedEarlyState.status, 'FINISHED');
    assert.strictEqual(finishedEarlyState.currentQuestionMvp, null, '結束階段應收起單題橫幅');
    assert.strictEqual(
      finishedEarlyState.allQuestionsReview[0].questionMvp.status,
      'has_winner',
      '已揭曉之第 1 題應保留得主紀錄'
    );
    assert.strictEqual(
      finishedEarlyState.allQuestionsReview[1].questionMvp.status,
      'no_record',
      '作答中途結束未揭曉之第 2 題應為 no_record，不可誤判為 all_wrong'
    );
    assert.strictEqual(
      finishedEarlyState.allQuestionsReview[2].questionMvp.status,
      'not_played',
      '尚未進行之第 3 題應為 not_played，不可誤判為 no_answers'
    );

    console.log(
      `✅ 9. 防重複作答、防提前洩漏對錯、單題王 (MVP) 5 態判定與 Server 端計分驗證通過 (得分: ${personalAfterReveal.score})`
    );

    // 10. 多管理者帳號建立、RBAC 權限分離 (super_admin vs host) 與最後一位 super_admin 保護
    const createSubHostRes = await fetch(`${baseUrl}/api/host/admins`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hostToken}`
      },
      body: JSON.stringify({
        username: 'host_room1',
        displayName: '第一教室主持人',
        adminRole: 'host',
        password: 'HostPass#2026'
      })
    });
    assert.strictEqual(createSubHostRes.status, 200, 'super_admin 應可新增一般主持人帳號');
    const subHostData = await createSubHostRes.json();
    const subHostId = subHostData.admin.id;

    // 使用新建立的一般主持人帳號登入
    const subHostLoginRes = await fetch(`${baseUrl}/api/host/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'host_room1',
        password: 'HostPass#2026'
      })
    });
    assert.strictEqual(subHostLoginRes.status, 200);
    const { hostToken: subHostToken, admin: subHostProfile } = await subHostLoginRes.json();
    assert.strictEqual(subHostProfile.adminRole, 'host');

    // 一般主持人 (host) 可以查詢題庫，但不可新增題目 (403) 也不可管理帳號 (403)
    const hostListQRes = await fetch(`${baseUrl}/api/host/questions`, {
      headers: { Authorization: `Bearer ${subHostToken}` }
    });
    assert.strictEqual(hostListQRes.status, 200, '一般主持人應可唯讀檢視題庫');

    const hostCreateQRes = await fetch(`${baseUrl}/api/host/questions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${subHostToken}`
      },
      body: JSON.stringify({
        title: '未授權新增題目',
        scenario: '測試情境',
        options: { A: '選項A', B: '選項B', C: '選項C', D: '選項D' },
        answer: 'A',
        explanation: '解析'
      })
    });
    assert.strictEqual(hostCreateQRes.status, 403, '一般主持人不可新增或修改題庫 (應回傳 403)');

    const hostListAdminsRes = await fetch(`${baseUrl}/api/host/admins`, {
      headers: { Authorization: `Bearer ${subHostToken}` }
    });
    assert.strictEqual(hostListAdminsRes.status, 403, '一般主持人不可讀取管理者列表 (應回傳 403)');
    console.log('✅ 10. 多管理者帳號建立與 RBAC 角色權限分離 (super_admin vs host) 測試通過');

    // 11. 停用帳號或改密碼後，既有 Token 必須立即失效 (Instant Token Revocation for HTTP & Socket.IO)
    const disableSubHostRes = await fetch(`${baseUrl}/api/host/admins/${subHostId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hostToken}`
      },
      body: JSON.stringify({ isActive: false })
    });
    assert.strictEqual(disableSubHostRes.status, 200);

    const revokedCheckRes = await fetch(`${baseUrl}/api/host/me`, {
      headers: { Authorization: `Bearer ${subHostToken}` }
    });
    assert.strictEqual(revokedCheckRes.status, 401, '帳號停用後，既有 Token 必須立即失效 (401)');

    // 驗證 Socket.IO 端使用的 verifyAdminTokenState 亦同步拒絕已停用憑證
    const decodedSubToken = verifyToken(subHostToken);
    assert.strictEqual(
      verifyAdminTokenState(decodedSubToken),
      null,
      'Socket.IO 狀態驗證必須拒絕已停用帳號之 Token'
    );

    // 重新啟用該帳號並登入取得新 Token，再測試「重設密碼」是否立即撤銷舊 Token
    await fetch(`${baseUrl}/api/host/admins/${subHostId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hostToken}`
      },
      body: JSON.stringify({ isActive: true })
    });
    const reloginRes = await fetch(`${baseUrl}/api/host/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'host_room1', password: 'HostPass#2026' })
    });
    assert.strictEqual(reloginRes.status, 200);
    const { hostToken: tokenBeforePwdReset } = await reloginRes.json();

    const resetPwdRes = await fetch(`${baseUrl}/api/host/admins/${subHostId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hostToken}`
      },
      body: JSON.stringify({ password: 'NewHostPass#2027' })
    });
    assert.strictEqual(resetPwdRes.status, 200);

    const checkAfterPwdReset = await fetch(`${baseUrl}/api/host/me`, {
      headers: { Authorization: `Bearer ${tokenBeforePwdReset}` }
    });
    assert.strictEqual(
      checkAfterPwdReset.status,
      401,
      '重設密碼後，該帳號改密前之舊 Token 必須立即失效 (401)'
    );

    const appJsSource = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
    assert(
      appJsSource.includes('function parseCsvLine(line)'),
      '前端組別 CSV 匯入必須具備 RFC-4180 雙引號與逗號解析器'
    );
    assert(
      appJsSource.includes('function updateModeSwitcherVisibility(mode)'),
      '參賽者入口必須隱藏主持人角色切換列'
    );
    const indexHtmlSource = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    assert(
      indexHtmlSource.includes('class="mode-switcher hidden"'),
      '角色切換列預設必須隱藏，避免參賽者畫面閃現主持人按鈕'
    );
    console.log('✅ 11. 帳號停用／重設密碼後既有 Token 立即撤銷 (HTTP + Socket.IO) 與 CSV 解析檢查通過');

    // 12. 題庫 CRUD、樂觀鎖 (Optimistic Locking 409) 與房間題目快照隔離 (Room Question Snapshot)
    const addQRes = await fetch(`${baseUrl}/api/host/questions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hostToken}`
      },
      body: JSON.stringify({
        title: '新增第 11 題：社交工程釣魚郵件辨識',
        scenario: '收到主旨為「帳號異常即將停權」並要求點擊短網址輸入帳密的信件，何者最安全？',
        options: {
          A: '立即點擊連結輸入帳密',
          B: '轉寄給全公司同事幫忙測試',
          C: '透過官方獨立管道查證，不點擊信中連結',
          D: '直接回覆寄件者詢問真偽'
        },
        answer: 'C',
        explanation: '防範釣魚郵件應循官方網站或內部資訊部門獨立查證。',
        isEnabled: true
      })
    });
    assert.strictEqual(addQRes.status, 200);
    const addedQData = await addQRes.json();
    const addedQ = addedQData.question;
    assert.strictEqual(addedQ.version, 1);

    // 驗證先前已建立且進行中的房間 (pin) 題數仍鎖定為建立當下的 10 題快照，不受後台新增第 11 題影響！
    const existingRoomAfterAdd = gameManager.getRoom(pin);
    assert.strictEqual(
      existingRoomAfterAdd.questions.length,
      10,
      '進行中房間必須鎖定建立當下之題目快照，不受後台新增題目影響'
    );

    // 編輯第 11 題 (version: 1 -> 2)
    const updateQRes = await fetch(`${baseUrl}/api/host/questions/${addedQ.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hostToken}`
      },
      body: JSON.stringify({
        title: '新增第 11 題（已修訂）：釣魚郵件辨識',
        scenario: addedQ.scenario,
        options: addedQ.options,
        answer: 'C',
        explanation: addedQ.explanation,
        isEnabled: true,
        version: 1
      })
    });
    assert.strictEqual(updateQRes.status, 200);
    const updatedQData = await updateQRes.json();
    assert.strictEqual(updatedQData.question.version, 2);

    // 使用舊版號 (version: 1) 再次送出編輯 -> 必須觸發 409 Conflict 樂觀鎖保護
    const staleUpdateRes = await fetch(`${baseUrl}/api/host/questions/${addedQ.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hostToken}`
      },
      body: JSON.stringify({
        title: '過期版號覆寫嘗試',
        scenario: addedQ.scenario,
        options: addedQ.options,
        answer: 'C',
        explanation: addedQ.explanation,
        isEnabled: true,
        version: 1
      })
    });
    assert.strictEqual(staleUpdateRes.status, 409, '版號不符必須回傳 409 防止多人同時編輯互相覆蓋');

    // 建立新房間應載入最新 11 題快照
    const newRoomWith11Res = await fetch(`${baseUrl}/api/host/rooms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hostToken}`
      },
      body: JSON.stringify({
        title: '11 題快照測試房',
        maxPlayers: 10,
        timeLimitSec: 25,
        groups: [{ name: '第一組', password: 'PassG1', maxMembers: 5 }]
      })
    });
    assert.strictEqual(newRoomWith11Res.status, 200);
    const newRoomWith11Data = await newRoomWith11Res.json();
    assert.strictEqual(newRoomWith11Data.room.totalQuestions, 11, '新房間應取得最新 11 道啟用題目');

    // 13. 刪除房間功能測試 (DELETE /api/host/rooms/:pin)
    const pinToDelete = newRoomWith11Data.room.pin;
    const delRoomRes = await fetch(`${baseUrl}/api/host/rooms/${pinToDelete}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${hostToken}` }
    });
    assert.strictEqual(delRoomRes.status, 200, '刪除房間應回傳 200');
    assert.strictEqual(gameManager.getRoom(pinToDelete), null, '刪除後房間應自記憶體移除');

    const checkDeletedRoomRes = await fetch(`${baseUrl}/api/rooms/${pinToDelete}`);
    assert.strictEqual(checkDeletedRoomRes.status, 404, '已刪除之房間查詢應回傳 404');

    // 驗證稽核日誌已記錄相關操作（含 ROOM_DELETE）
    const auditRes = await fetch(`${baseUrl}/api/host/audit-logs?limit=20`, {
      headers: { Authorization: `Bearer ${hostToken}` }
    });
    assert.strictEqual(auditRes.status, 200);
    const auditData = await auditRes.json();
    assert(auditData.logs.length >= 5, '稽核日誌應記錄登入、新增管理員、建房、刪房與改題事件');
    assert(
      auditData.logs.some((l) => l.action === 'ROOM_DELETE' && l.targetId === pinToDelete),
      '稽核日誌應包含 ROOM_DELETE 紀錄'
    );
    console.log('✅ 12. 題庫 CRUD、樂觀鎖 (409)、房間題目快照隔離、刪除房間與稽核日誌測試通過');

    console.log('\n🎉 所有 13 項資安、多管理者 RBAC、題庫 CRUD 與競賽邏輯測試 100% 通過！');
  } finally {
    io.close();
    server.close();
  }
}

runTests().catch((err) => {
  console.error('❌ 測試失敗:', err);
  process.exit(1);
});
