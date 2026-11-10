'use strict';

/**
 * 真實瀏覽器端對端測試（Microsoft Edge / Chrome headless + puppeteer-core）
 * 模擬一場完整活動：主持人登入 → 建房 → 投影幕 → 3 位參賽者掃碼加入 → 全部題目作答
 * → 揭曉／排行榜／略過排行榜／提前截止 → 中途重新整理重連 → 結束比賽 → 刪除房間。
 *
 * 執行：npm run test:e2e
 * 可用環境變數 BROWSER_PATH 指定瀏覽器執行檔。
 */

const assert = require('assert');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

process.env.HOST_PASSWORD = process.env.HOST_PASSWORD || 'E2E_HostPass#2026';
const { createAppServer } = require('../src/server');

const BROWSER_CANDIDATES = [
  process.env.BROWSER_PATH,
  // 注意：本機 Edge 受企業原則 RemoteDebuggingAllowed=0 限制無法自動化，故優先使用 Chrome
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean);

const STEP_TIMEOUT = 8000;
const pageErrors = [];
let currentStep = 'init';
const debugPages = {};

function log(msg) {
  console.log(`  ${msg}`);
}

async function newIsolatedPage(browser, label) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  debugPages[label] = page;
  page.setDefaultTimeout(STEP_TIMEOUT);
  page.on('pageerror', (err) => pageErrors.push(`[${label}] pageerror: ${err.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(`[${label}] console.error: ${m.text()}`);
  });
  page.on('dialog', (d) => d.dismiss());
  return page;
}

const isVisible = (page, sel) =>
  page.$eval(sel, (el) => !el.classList.contains('hidden') && el.getClientRects().length > 0).catch(() => false);

async function waitVisible(page, sel, timeout = STEP_TIMEOUT) {
  await page.waitForFunction(
    (s) => {
      const el = document.querySelector(s);
      return el && !el.classList.contains('hidden') && el.getClientRects().length > 0;
    },
    { timeout },
    sel
  );
}

async function clickConfirm(page) {
  await waitVisible(page, '#confirmModal');
  await page.click('#btnConfirmProceed');
  await page.waitForFunction(() => document.getElementById('confirmModal').classList.contains('hidden'));
}

/** 參賽者畫面：等待第 n 題出現，且 4 個選項全部可點（本次 bug 的核心檢查） */
async function waitQuestionUnlocked(page, n, label) {
  try {
    await page.waitForFunction(
      (num) => {
        const qs = document.getElementById('playerQuestionState');
        if (!qs || qs.classList.contains('hidden')) return false;
        if (!document.getElementById('playerQProgress').textContent.includes(`第 ${num}／`)) return false;
        const btns = [...document.querySelectorAll('#playerOptionsGrid .option-btn')];
        return (
          btns.length === 4 &&
          btns.every((b) => !b.disabled && !b.classList.contains('selected-choice')) &&
          document.getElementById('playerLockedBanner').classList.contains('hidden')
        );
      },
      { timeout: STEP_TIMEOUT },
      n
    );
  } catch {
    const snap = await page.evaluate(() => ({
      progress: document.getElementById('playerQProgress')?.textContent,
      disabled: [...document.querySelectorAll('#playerOptionsGrid .option-btn')].map((b) => b.disabled),
      locked: document.getElementById('playerLockedTitle')?.textContent
    }));
    throw new Error(`[${label}] 第 ${n} 題選項未解鎖：${JSON.stringify(snap)}`);
  }
}

async function answer(page, option) {
  await page.click(`#playerOptionsGrid .option-btn[data-option="${option}"]`);
  await page.waitForFunction(
    () => document.getElementById('playerLockedTitle').textContent === '答案已送出'
  );
}

async function waitReveal(page, label) {
  await page.waitForFunction(() => {
    const st = document.getElementById('playerRevealState');
    const t = document.getElementById('playerResultTitle').textContent;
    return st && !st.classList.contains('hidden') && ['答對', '答錯', '本題未作答'].includes(t);
  });
  return page.$eval('#playerResultTitle', (el) => el.textContent).catch(() => `[${label}] ?`);
}

async function hostClick(page, sel) {
  await page.waitForFunction(
    (s) => {
      const b = document.querySelector(s);
      return b && !b.classList.contains('hidden') && !b.disabled;
    },
    {},
    sel
  );
  await page.click(sel);
}

async function run() {
  const browserPath = BROWSER_CANDIDATES.find((p) => fs.existsSync(p));
  assert(browserPath, '找不到 Edge／Chrome，請設定 BROWSER_PATH');

  const { server, io, gameManager, hostPassword } = createAppServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`[E2E] server ${base}｜browser ${browserPath}`);

  // 主持人與投影幕共用 1 個瀏覽器、每位參賽者各自獨立 context（等同不同手機）
  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: true,
    protocolTimeout: 60000,
    args: ['--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check']
  });

  try {
    // ---------- 1. 主持人登入與建房 ----------
    const host = await newIsolatedPage(browser, 'host');
    await host.goto(`${base}/host`, { waitUntil: 'networkidle0' });
    assert(await isVisible(host, '.mode-switcher'), '主持人頁 /host 應顯示角色切換列');
    await host.$eval('#inputHostUsername', (el) => (el.value = 'admin'));
    await host.type('#inputHostPassword', hostPassword);
    await host.click('#btnHostLoginSubmit');
    await waitVisible(host, '#hostSetupCard');
    await host.$eval('#setupTimeLimit', (el) => (el.value = '20'));
    await host.click('#btnCreateRoomSubmit');
    await host.waitForFunction(() => /^\d{6}$/.test(document.getElementById('hostPinDisplay').textContent));
    const pin = await host.$eval('#hostPinDisplay', (el) => el.textContent);
    const room = gameManager.getRoom(pin);
    const total = room.questions.length;
    const g1 = room.groups.get('G1');
    const g2 = room.groups.get('G2');
    const bgmOptCount = await host.$$eval('#selectHostBgmTrack option', (opts) => opts.length);
    assert(bgmOptCount >= 18, `BGM 選單應包含 15 首曲目與輪播選項，實際：${bgmOptCount}`);
    await host.click('#btnToggleBgm');
    log(`✅ 主持人登入並建立房間 PIN ${pin}（${total} 題，BGM 選單 ${bgmOptCount} 項）`);

    // ---------- 2. 投影幕 ----------
    const display = await newIsolatedPage(browser, 'display');
    await display.goto(`${base}/display/${pin}`, { waitUntil: 'networkidle0' });
    await display.waitForFunction((p) => document.getElementById('hostPinDisplay').textContent === p, {}, pin);
    assert(!(await isVisible(display, '.mode-switcher')), '投影幕不可顯示角色切換列');
    assert(!(await isVisible(display, '#hostActionButtons')), '投影幕不可顯示主持人操作按鈕');
    log('✅ 投影幕載入，無主持人按鈕');

    // ---------- 3. 三位參賽者掃碼加入 ----------
    const players = [];
    const defs = [
      { label: 'P1', nick: '小明', group: g1 },
      { label: 'P2', nick: '小華', group: g1 },
      { label: 'P3', nick: '小美', group: g2 }
    ];
    for (const d of defs) {
      const p = await newIsolatedPage(browser, d.label);
      await p.goto(`${base}/?pin=${pin}&group=${d.group.code}`, { waitUntil: 'domcontentloaded' });
      await p.waitForFunction(() => {
        const b = document.getElementById('btnJoinRoom');
        return b && !b.disabled && !document.getElementById('playerJoinForm').classList.contains('hidden');
      });
      assert(!(await isVisible(p, '.mode-switcher')), `${d.label} 參賽者畫面不可出現主持人切換按鈕`);
      await p.type('#inputGroupPassword', d.group.plainPassword);
      await p.type('#inputNickname', d.nick);
      await p.click('#btnJoinRoom');
      await waitVisible(p, '#playerLobbyState');
      players.push({ ...d, page: p });
    }
    await host.waitForFunction(() => document.getElementById('hostPlayerCountPill').textContent.includes('3／'));
    await display.waitForFunction(() => document.getElementById('hostPlayerCountPill').textContent.includes('3／'));
    log('✅ 3 位參賽者掃碼加入，主持人與投影幕人數同步 3 人');

    // 錯誤密碼應顯示錯誤且按鈕可再按
    const bad = await newIsolatedPage(browser, 'P-bad');
    await bad.goto(`${base}/?pin=${pin}&group=G2`, { waitUntil: 'domcontentloaded' });
    await bad.waitForFunction(() => !document.getElementById('btnJoinRoom').disabled);
    await bad.type('#inputGroupPassword', 'wrong-pass');
    await bad.type('#inputNickname', '測試錯誤');
    await bad.click('#btnJoinRoom');
    await bad.waitForFunction(() => {
      const errs = ['passwordError', 'joinGeneralError'].map((id) => document.getElementById(id));
      return errs.some((e) => e && !e.classList.contains('hidden') && e.textContent.trim());
    });
    assert(!(await bad.$eval('#btnJoinRoom', (b) => b.disabled)), '密碼錯誤後加入按鈕應可再次點擊');
    await bad.browserContext().close();
    log('✅ 錯誤組別密碼正確提示，按鈕未鎖死');

    // ---------- 3.5 模擬主持人回後台點擊「進入控場」＋模擬參賽者 WebSocket 漏綁後仍能透過雙通道同步進入第 1 題 ----------
    await hostClick(host, '#btnHostNewRoom');
    await clickConfirm(host);
    await waitVisible(host, '#hostSetupCard');
    await host.waitForFunction(() => document.querySelectorAll('#activeRoomsList .btn-primary').length > 0);
    await host.click('#activeRoomsList .btn-primary');
    await waitVisible(host, '#hostActiveRoomArea');
    // 模擬 P3 的 Socket 意外脫離 room 廣播頻道（驗證 2 秒 HTTP 狀態同步保底機制）
    for (const s of io.sockets.sockets.values()) {
      if (s.data?.role === 'player') {
        s.leave(`room:${pin}`);
        break;
      }
    }
    log('✅ 主持人從後台列表「進入控場」重連成功');

    // ---------- 4. 全部題目 ----------
    let prevBgmLabel = await host.$eval('#btnToggleBgm', (el) => el.textContent.trim());
    await hostClick(host, '#btnHostNextQuestion');
    for (let i = 0; i < total; i++) {
      const n = i + 1;
      const q = room.questions[i];
      const wrong = ['A', 'B', 'C', 'D'].find((o) => o !== q.answer);

      currentStep = `Q${n} 等待選項解鎖`;
      for (const p of players) await waitQuestionUnlocked(p.page, n, p.label);
      const curBgmLabel = await host.$eval('#btnToggleBgm', (el) => el.textContent.trim());
      assert.notStrictEqual(
        curBgmLabel,
        prevBgmLabel,
        `第 ${n} 題應自動切換不同 BGM（上一首：${prevBgmLabel}，本題：${curBgmLabel}）`
      );
      prevBgmLabel = curBgmLabel;
      currentStep = `Q${n} 投影幕題號`;
      await display.waitForFunction(
        (num) => document.getElementById('hostQNumberBadge').textContent.includes(`第 ${num}／`),
        {},
        n
      );

      // 第 3 題：P2 中途重新整理，驗證重連後仍可作答
      if (n === 3) {
        await players[1].page.reload({ waitUntil: 'domcontentloaded' });
        await waitQuestionUnlocked(players[1].page, n, 'P2(reload)');
        log('   ↻ 第 3 題 P2 重新整理後選項仍可作答');
      }

      currentStep = `Q${n} P1/P2 作答`;
      await answer(players[0].page, q.answer);
      await answer(players[1].page, wrong);
      currentStep = `Q${n} 截止／自動揭曉`;

      // 第 4 題：P2 已作答後重新整理，應維持「已送出」鎖定且不可重答
      if (n === 4) {
        await players[1].page.reload({ waitUntil: 'domcontentloaded' });
        await players[1].page.waitForFunction(
          () =>
            document.getElementById('playerLockedTitle').textContent === '答案已送出' &&
            [...document.querySelectorAll('#playerOptionsGrid .option-btn')].every((b) => b.disabled)
        );
        log('   ↻ 第 4 題 P2 作答後重新整理，正確維持已送出狀態');
      }

      const p3Skips = n % 2 === 0; // 偶數題 P3 不作答 → 主持人提前截止
      if (p3Skips) {
        await hostClick(host, '#btnHostRevealAnswer');
        await clickConfirm(host);
      } else {
        await answer(players[2].page, q.answer); // 全員作答 → 自動揭曉
      }

      currentStep = `Q${n} 等待揭曉畫面`;
      const r1 = await waitReveal(players[0].page, 'P1');
      const r2 = await waitReveal(players[1].page, 'P2');
      const r3 = await waitReveal(players[2].page, 'P3');
      assert.strictEqual(r1, '答對', `第 ${n} 題 P1 應顯示答對`);
      assert.strictEqual(r2, '答錯', `第 ${n} 題 P2 應顯示答錯`);
      assert.strictEqual(r3, p3Skips ? '本題未作答' : '答對', `第 ${n} 題 P3 結果錯誤`);

      currentStep = `Q${n} 主持人下一步`;
      await host.waitForFunction(
        () =>
          !document.getElementById('hostRevealMvpLine').classList.contains('hidden') &&
          document.getElementById('hostRevealMvpLine').textContent.includes('小明')
      );
      const isLast = n === total;
      if (isLast || n % 3 === 0) {
        await hostClick(host, '#btnHostShowLeaderboard');
        for (const p of players) await waitVisible(p.page, '#playerLeaderboardState');
        await host.waitForFunction(
          () =>
            !document.getElementById('hostQuestionMvpBanner').classList.contains('hidden') &&
            document.getElementById('hostQuestionMvpBanner').textContent.includes('小明') &&
            document.querySelector('#hostIndividualLeaderboard .lb-row.is-question-mvp')?.textContent.includes('⚡ 本題最高')
        );
        await players[0].page.waitForFunction(
          () =>
            !document.getElementById('playerQuestionMvpBanner').classList.contains('hidden') &&
            document.getElementById('playerQuestionMvpBanner').textContent.includes('小明') &&
            document.querySelector('#playerIndividualList .lb-row.is-question-mvp')?.textContent.includes('⚡ 本題最高')
        );
        if (isLast) {
          await hostClick(host, '#btnHostFinishGame');
          await clickConfirm(host);
        } else {
          await hostClick(host, '#btnHostNextQuestion');
        }
      } else {
        await hostClick(host, '#btnHostSkipToNext');
      }
      log(`✅ 第 ${n}/${total} 題：選項可作答 → P1 ${r1}｜P2 ${r2}｜P3 ${r3}`);
    }

    // ---------- 5. 結束 ----------
    for (const p of players) {
      await p.page.waitForFunction(() => document.getElementById('playerLbHeading').textContent === '測驗已結束');
    }
    await waitVisible(host, '#hostPodiumSection');
    await waitVisible(host, '#hostAllQuestionsMvpCard');
    await host.waitForFunction(
      (expectedTotal) =>
        document.getElementById('hostQuestionMvpBanner').classList.contains('hidden') &&
        document.querySelectorAll('#hostAllQuestionsMvpList .mvp-summary-row').length === expectedTotal,
      {},
      total
    );
    await players[0].page.waitForFunction(
      () =>
        document.getElementById('playerQuestionMvpBanner').classList.contains('hidden') &&
        document.getElementById('playerAllReviewList').textContent.includes('👑 本題單題王：小明')
    );
    const final = gameManager.getRoom(pin);
    const scores = [...final.players.values()].map((p) => `${p.nickname}:${p.score}`).join('、');
    const p1 = [...final.players.values()].find((p) => p.nickname === '小明');
    assert.strictEqual(p1.correctCount, total, 'P1 應全部答對');
    log(`✅ 比賽結束，頒獎台顯示；分數 ${scores}`);

    // ---------- 6. 刪除房間 ----------
    await hostClick(host, '#btnHostDeleteRoom');
    await clickConfirm(host);
    await waitVisible(host, '#hostSetupCard');
    for (const p of players) {
      await waitVisible(p.page, '#playerJoinCard');
      await p.page.waitForFunction(() => document.getElementById('joinGeneralError').textContent.includes('刪除'));
    }
    assert.strictEqual(gameManager.getRoom(pin), null, '房間應已刪除');
    log('✅ 刪除房間：主持人回後台，參賽者收到通知並退回加入頁');

    const relevantErrors = pageErrors.filter((e) => !/favicon|Failed to load resource/i.test(e));
    assert.deepStrictEqual(relevantErrors, [], `瀏覽器出現錯誤：\n${relevantErrors.join('\n')}`);
    console.log(`\n🎉 E2E 全流程通過（${total} 題，主持人＋投影幕＋3 位參賽者）`);
  } catch (err) {
    for (const [label, pg] of Object.entries(debugPages)) {
      const snap = await pg
        .evaluate(() => ({
          host: ['btnHostNextQuestion', 'btnHostRevealAnswer', 'btnHostShowLeaderboard', 'btnHostSkipToNext', 'btnHostFinishGame']
            .map((id) => document.getElementById(id))
            .filter((b) => b && !b.classList.contains('hidden'))
            .map((b) => `#${b.id}(${b.textContent.trim()}${b.disabled ? ',disabled' : ''})`),
          status: document.getElementById('hostStatusPill')?.textContent,
          modal: !document.getElementById('confirmModal').classList.contains('hidden'),
          playerLocked: document.getElementById('playerLockedTitle')?.textContent,
          toast: document.getElementById('toastContainer')?.textContent
        }))
        .catch((e) => e.message);
      console.error(`  [${label}]`, JSON.stringify(snap));
    }
    throw err;
  } finally {
    await browser.close();
    io.close();
    server.close();
  }
}

run().catch((err) => {
  console.error(`❌ E2E 失敗（步驟：${currentStep}）:`, err.message);
  if (pageErrors.length) console.error(pageErrors.join('\n'));
  process.exit(1);
});
