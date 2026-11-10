# CyberQuiz｜神手速快問快答大亂鬥

專為 **現場活動、派對競賽與互動教學** 設計的多人即時連線搶答 Web 系統。參考 Kahoot! 與 ClassQuiz 的即時互動架構，並針對競賽現場強化伺服器端零信任防作弊（Zero-Trust Client）與 OWASP Web 資安防護。

完整的系統架構圖、時序圖、資料庫 Schema 與 GCP 部署維運指南請參閱：
- **[系統架構與維運技術文件 (`docs/ARCHITECTURE.md`)](docs/ARCHITECTURE.md)**

---

## 核心功能與競賽規則

1. **開箱即玩內建 10 道「台灣價值（活網與台灣日常文化）」預設題庫 ＋ `docs/` 試玩題庫範本**：
   - Clone 後無須自己想題目即可直接啟動開玩；`docs/` 內亦附有 5 題快速試玩版與題庫匯入範本，支援後台一鍵 JSON 匯入／匯出。
2. **個人積分賽 ＋ 組別密碼白名單 ＋ 雙重人數上限**：
   - **全場總人數上限**：可於建立房間時設定（1～500 人，預設 100 人）。
   - **單組人數上限與組別專屬密碼**：支援設定組別數量或直接批次貼上組別清單（每行一組），系統自動為每組產生高強度隨機密碼。
   - **個人與組別雙榜統計**：同時計算「個人排行榜」與「組別排行榜（平均分／總分）」，結束時支援匯出 UTF-8 BOM CSV 成績單。
3. **三端角色與路由分離（防投影洩密與誤觸）**：
   - **參賽端 (`/`)**：手機優先的 `2×2` 免捲動搶答網格、點擊立即鎖定、斷線全寬遮罩保護。
   - **主持人控制台 (`/host`)**：建立房間、複製組別密碼清單、控題、二次確認防誤觸（提前截止／移除參賽者／重新開房／公布最終結果）。
   - **唯讀大螢幕投影端 (`/display/:pin`)**：透過唯讀 Socket 頻道同步題目與排行榜，不含任何組別密碼或管理按鈕。

---

## 資安與防作弊設計重點

- **作答期間零答案洩漏 (`QUESTION_OPEN`)**：[`sanitizeQuestionForOpenPhase`](src/questions.js) 嚴格剝除 `answer`、`correctIndex` 與 `explanation`，開啟瀏覽器 `F12` 檢視封包亦無法得知答案。
- **揭曉前不提前透露對錯**：參賽者送出答案後僅回傳「已鎖定選項」，直到全場截止進入 `QUESTION_REVEAL` 才統一公布對錯與得分。
- **伺服器端單調時鐘 (`performance.now()`) 計分**：完全不採信前端時間戳記，並於記憶體與 PostgreSQL `UNIQUE (room_pin, player_id, question_idx)` 雙重鎖定每題僅能作答一次。
- **防暴力破解鎖定優先檢查**：於執行 `scrypt` + `timingSafeEqual` 密碼比對前先檢查滑動視窗鎖定狀態（`isBlocked`），鎖定期間連正確密碼亦強制拒絕。
- **資料庫最小權限角色 (`cyber_quiz_worker`)**：連線池自動執行 `SET ROLE cyber_quiz_worker;`（`NOSUPERUSER NOCREATEDB NOCREATEROLE`），確保執行期最小權限。

---

## 本地啟動與自動化測試

```bash
# 安裝依賴套件
npm install

# 執行 13 項資安、防作弊與 UI/UX 結構自動化測試
npm test

# 啟動伺服器 (預設 http://localhost:8080)
npm start
```
