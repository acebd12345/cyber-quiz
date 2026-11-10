# CyberQuiz Arena (神手速快問快答大亂鬥) — 系統架構設計文件

> [!NOTE]
> **文件版本**：v2.1.0（含多管理者 RBAC、後台題庫 CRUD、單題最高分 MVP、房間題目快照與稽核日誌）  
> **生產環境網址**：`https://<your-cloud-run-service>.asia-east1.run.app`  
> **部署平台**：Google Cloud Run (`asia-east1`) + Cloud SQL for PostgreSQL 18 (`<your-cloudsql-instance>` / `cyber_quiz`)

---

## 1. 系統全景架構圖 (System Context & Cloud Topology)

系統採用單體式即時雙向架構（Node.js + Express + Socket.IO），部署於 Google Cloud Run，並透過 Unix Domain Socket 連接 Cloud SQL PostgreSQL 18。針對現場競賽高併發需求，由 [`GameManager`](../src/gameManager.js) 在記憶體維護毫秒級計時與即時狀態，並以 Write-Behind 非同步寫入 PostgreSQL 確保資料持久化。

```mermaid
flowchart TB
    subgraph Clients["終端使用者與顯示裝置"]
        Player["📱 參賽者端 (手機瀏覽器)<br/>路徑: /?pin=XXXXXX"]
        Host["💻 主持人與管理後台 (筆電/桌機)<br/>路徑: /host"]
        Display["📽️ 投影展示端 (大銀幕唯讀)<br/>路徑: /display/:pin"]
    end

    subgraph GCP["Google Cloud Platform (Project: your-gcp-project / Region: asia-east1)"]
        subgraph CloudRun["Cloud Run Service: cyber-quiz"]
            Express["Express HTTP 伺服器<br/>REST API + 靜態資源 + Helmet CSP"]
            SocketIO["Socket.IO 即時雙向引擎<br/>房間廣播 / 毫秒級計時同步"]
            Sec["Security 資安與驗證模組<br/>HMAC Token / scrypt (含防時序枚舉) / RateLimiter"]
            GM["GameManager 競賽狀態機<br/>In-Memory 房間快照 + Write-Behind"]
        end

        subgraph SecretMgr["Cloud Secret Manager"]
            SecJwt["cyber-quiz-jwt-secret"]
            SecHost["cyber-quiz-host-password"]
            SecDbUrl["cyber-quiz-db-url"]
        end

        subgraph CloudSQL["Cloud SQL for PostgreSQL 18 (cyber-quiz-db)"]
            PG[("Database: cyber_quiz<br/>Role: cyber_quiz_worker (Least Privilege)<br/>7 張核心資料表")]
        end
    end

    Player -- "HTTPS REST (查房/入房)<br/>WSS Socket.IO (搶答/同步)" --> Express & SocketIO
    Host -- "HTTPS REST (多帳號登入/建房/題庫CRUD/帳號管理)<br/>WSS Socket.IO (控場/揭曉/排行)" --> Express & SocketIO
    Display -- "WSS Socket.IO (display:subscribe)<br/>唯讀投影訂閱 (零密碼暴露)" --> SocketIO

    Express --> Sec
    SocketIO --> Sec
    Express --> GM
    SocketIO --> GM
    GM -- "連線池非同步持久化 (Write-Behind)<br/>Unix Socket (/cloudsql/...)" --> PG
    SecJwt & SecHost & SecDbUrl -. "環境變數安全注入" .-> CloudRun
```

---

## 2. 模組職責與檔案結構 (Component Architecture)

```mermaid
flowchart LR
    subgraph Frontend["前端靜態層 (public/)"]
        HTML["index.html<br/>三視角切換 (/、/host、/display/:pin)<br/>後台三分頁 (房間/題庫/管理者)"]
        CSS["styles.css<br/>亮色教育活動設計系統 (#F5F7FA)<br/>手機首屏 2x2 雙欄 + WCAG AA"]
        APP["app.js<br/>狀態同步、防連點鎖定、斷線遮罩、<br/>題庫編輯與管理者RBAC介面"]
    end

    subgraph Backend["後端核心層 (src/)"]
        SRV["server.js<br/>HTTP 路由、多管理者 RBAC 中介、CSP、<br/>Socket.IO 事件與即時 Token 撤銷檢查"]
        GM2["gameManager.js<br/>房間生命週期、房間題目快照鎖定、<br/>計時器與計分引擎"]
        SEC["security.js<br/>HMAC-SHA256 Token、scrypt 常數時間雜湊、<br/>題目與帳號白名單消毒、SlidingWindow 限流"]
        DB["db.js<br/>PostgreSQL 連線池、自動 Migration、<br/>管理員/題庫/稽核日誌 CRUD 與記憶體 Fallback"]
        QDATA["questions.js<br/>預設 10 道資安與數位素養題庫種子"]
    end

    HTML & CSS --> APP
    APP <--> SRV
    SRV --> SEC & GM2 & DB
    GM2 --> SEC & DB & QDATA
    DB --> QDATA & SEC
```

| 檔案路徑 | 核心職責說明 |
| :--- | :--- |
| [`src/server.js`](../src/server.js) | Express 與 Socket.IO 入口；設定嚴格 Helmet CSP、雙層登入限流（IP + 帳號）、`/api/host/*` RBAC 路由（`super_admin` 與 `host`）、以及每次操作強制執行的 `verifyHostAccess` 即時撤銷檢查。 |
| [`src/gameManager.js`](../src/gameManager.js) | 核心競賽狀態機；建房時將啟用題庫深拷貝鎖定至 `room.questions`（題目快照），負責房間建立、組別密碼驗證、雙層人數上限、倒數計時與個人/組別排行榜計算。 |
| [`src/security.js`](../src/security.js) | 實作 HMAC-SHA256 Token、具備 `DUMMY_SCRYPT_HASH` 防時序枚舉的 `scrypt` 密碼驗證、題目與帳號白名單驗證、以及滑動視窗防暴力破解限流器。 |
| [`src/db.js`](../src/db.js) | 管理 PostgreSQL 連線池、Schema 自動遷移、預設管理員初始化（`ensureBootstrapAdmin`）、`adminStateCache` 即時憑證狀態快取、題庫樂觀鎖 CRUD 與稽核日誌寫入。 |
| [`src/questions.js`](../src/questions.js) | 內建 10 道台灣個資法、著作權法與 AI 倫理情境題，僅於資料庫題庫為空時自動寫入種子資料。 |
| [`public/index.html`](../public/index.html) | 單頁式三視角結構：參賽者介面（`/`）、主持人與後台管理中心（`/host`，含「房間管理」、「題庫管理」、「管理者與日誌」三分頁）、唯讀投影頁（`/display/:pin`）。 |
| [`public/styles.css`](../public/styles.css) | 亮色教育活動設計系統（`#F5F7FA` 背景、`#FFFFFF` 表面、`#2457D6` 主色），確保手機首屏 2×2 答題不捲動與鍵盤 `:focus-visible` 無障礙支援。 |
| [`public/app.js`](../public/app.js) | 前端狀態管理、伺服器時鐘偏移校正（`serverClockOffsetMs`）、防連點鎖定、題庫新增/編輯/排序/匯入匯出、以及管理者帳號與稽核日誌管理。 |

---

## 3. 競賽狀態機與房間題目快照 (Game State Machine & Snapshot Isolation)

每個房間在建立時會將當下已啟用的中央題庫鎖定為房間專屬快照（`questions_snapshot`），確保比賽進行中即使後台修改題庫，也不會影響進行中的房間：

```mermaid
stateDiagram-v2
    [*] --> LOBBY : 主持人建立房間 (鎖定當下啟用題庫至 questions_snapshot)
    LOBBY --> LOBBY : 參賽者加入 / 主持人在開賽前點擊「同步題庫」
    LOBBY --> QUESTION_OPEN : host:next_question (開始第 1 題)
    QUESTION_OPEN --> QUESTION_REVEAL : 倒數計時歸零 / 全員作答完畢 / host:reveal_answer (提前截止)
    QUESTION_REVEAL --> LEADERBOARD : host:show_leaderboard (查看排行榜)
    QUESTION_REVEAL --> QUESTION_OPEN : host:next_question (略過排行榜，直接下一題)
    LEADERBOARD --> QUESTION_OPEN : host:next_question (尚有下一題)
    LEADERBOARD --> FINISHED : host:finish_game (最後一題結束，公布最終前三名)
    QUESTION_REVEAL --> FINISHED : host:finish_game (最後一題直接結算)
    FINISHED --> [*]
```

### 階段權限與防作弊保護規則
1. **`LOBBY`（等待室）**：參賽者驗證組別密碼加入；主持人可在開賽前點擊「同步題庫」更新房間快照。
2. **`QUESTION_OPEN`（作答進行中）**：
   - 後端 [`buildPublicState`](../src/gameManager.js#L622-L675) **強制濾除 `answer` 與 `explanation` 欄位**，前端無法從封包偷看答案。
   - 參賽者送出答案後，僅回傳 `acceptedOption` 與 `elapsedMs`，**揭曉前絕不提前透露對錯或加分**。
   - 狀態機鎖定防連點：在 `QUESTION_OPEN` 階段再次觸發 `host:next_question` 會直接拒絕，避免主持人誤觸跳題。
3. **`QUESTION_REVEAL`（答案揭曉）**：結算本題得分與各選項作答分布（A/B/C/D 人數與百分比），並公開正確答案與法規解析。
4. **`LEADERBOARD`（中場排行榜）**：計算個人前 10 名與組別平均分排行。
5. **`FINISHED`（最終頒獎與完整解析）**：顯示前三名頒獎台、匯出成績 CSV，並向參賽者開放全題目完整解析回顧。

---

## 4. 多管理者 RBAC、認證與題庫管理流程 (Multi-Admin RBAC & Question Bank Flow)

```mermaid
sequenceDiagram
    autonumber
    actor Super as 💻 最高管理員 (super_admin)
    actor Host as 💻 一般主持人 (host)
    participant Srv as Express / Socket.IO (server.js)
    participant DB as PostgreSQL / Cache (db.js)

    Super->>Srv: POST /api/host/login { username: "admin", password }
    Srv->>DB: authenticateAdmin() (scrypt 常數時間驗證)
    DB-->>Srv: 回傳 admin (role: super_admin, tokenVersion: 1)
    Srv-->>Super: 簽發 hostToken (含 adminId, username, adminRole, tokenVersion)

    Super->>Srv: POST /api/host/admins (新增一般主持人 host_01)
    Srv->>DB: createAdminInDb() + writeAuditLog("admin.create")
    DB-->>Super: 建立成功

    Super->>Srv: PUT /api/host/questions/:id (帶入 version 樂觀鎖修改題目)
    Srv->>DB: updateQuestionInDb() (檢查 version 相符後 version + 1)
    DB-->>Super: 更新成功 (若版號不符則回傳 409 Conflict)

    Host->>Srv: POST /api/host/login { username: "host_01", password }
    Srv-->>Host: 簽發 hostToken (adminRole: "host", tokenVersion: 1)

    Host->>Srv: POST /api/host/rooms (建立比賽房間)
    Srv->>DB: 讀取已啟用題庫並鎖定寫入 quiz_rooms.questions_snapshot
    Srv-->>Host: 回傳房間 PIN 與鎖定題數

    Super->>Srv: PATCH /api/host/admins/:id { isActive: false } (停用 host_01)
    Srv->>DB: 更新 is_active=false, token_version+1 並同步 adminStateCache
    Host->>Srv: 任何 API 或 Socket.IO host:* 操作
    Srv->>DB: verifyAdminTokenState() 發現帳號已停用 / tokenVersion 不符
    Srv-->>Host: 401 Unauthorized (憑證立即失效)
```

---

## 5. 資料庫 Schema 設計 (Database ER Diagram)

資料庫名稱為 `cyber_quiz`，共包含 7 張資料表，應用程式透過最小權限帳號 `cyber_quiz_worker` 進行存取：

```mermaid
erDiagram
    quiz_admins {
        SERIAL id PK
        VARCHAR_32 username UK "登入帳號 (小寫唯一)"
        VARCHAR_64 display_name "顯示名稱"
        TEXT password_hash "scrypt 鹽值雜湊"
        VARCHAR_20 admin_role "super_admin | host"
        BOOLEAN is_active "是否啟用"
        INTEGER token_version "撤銷憑證版號 (改密/停用時+1)"
        TIMESTAMPTZ created_at "建立時間"
        TIMESTAMPTZ last_login_at "最後登入時間"
    }

    quiz_audit_logs {
        BIGSERIAL id PK
        VARCHAR_32 actor_username "操作者帳號"
        VARCHAR_20 actor_role "操作者角色"
        VARCHAR_64 action "動作代碼 (如 question.update)"
        VARCHAR_32 target_type "目標類型 (admin/question/room)"
        VARCHAR_64 target_id "目標 ID 或房間 PIN"
        JSONB details "結構化異動摘要"
        VARCHAR_64 ip_address "來源 IP"
        TIMESTAMPTZ created_at "發生時間"
    }

    quiz_questions {
        SERIAL id PK
        INTEGER question_number "顯示題號"
        INTEGER sort_order "題目排序權重"
        BOOLEAN is_enabled "是否納入新建房間題庫"
        INTEGER version "樂觀鎖版號 (防多人覆蓋)"
        TEXT title "題目標題"
        TEXT scenario "情境描述"
        TEXT option_a "選項 A"
        TEXT option_b "選項 B"
        TEXT option_c "選項 C"
        TEXT option_d "選項 D"
        CHAR_1 correct_option "正確答案 (A/B/C/D)"
        TEXT explanation "法規與素養解析"
        VARCHAR_64 updated_by "最後修改者帳號"
        TIMESTAMPTZ updated_at "最後更新時間"
    }

    quiz_rooms {
        VARCHAR_12 pin PK "6 位數房間 PIN"
        TEXT title "房間標題"
        VARCHAR_24 status "LOBBY | QUESTION_OPEN | QUESTION_REVEAL | LEADERBOARD | FINISHED"
        INTEGER max_players "房間總人數上限"
        INTEGER time_limit_sec "每題作答秒數"
        INTEGER current_question_idx "目前題號索引"
        JSONB questions_snapshot "建房當下鎖定之題目快照陣列"
        VARCHAR_64 created_by "建立房間之管理員帳號"
        TIMESTAMPTZ created_at "建立時間"
        TIMESTAMPTZ finished_at "結束時間"
    }

    quiz_groups {
        SERIAL id PK
        VARCHAR_12 room_pin FK "所屬房間 PIN"
        VARCHAR_32 group_code "組別代碼 (G1~G50)"
        VARCHAR_64 group_name "組別名稱"
        TEXT password_hash "scrypt 密碼雜湊"
        TEXT password_cipher "AES-256-GCM 加密之組別密碼"
        INTEGER max_members "該組人數上限"
    }

    quiz_players {
        VARCHAR_64 player_id PK "參賽者 UUID"
        VARCHAR_12 room_pin FK "所屬房間 PIN"
        VARCHAR_32 group_code "所屬組別代碼"
        VARCHAR_64 group_name "所屬組別名稱"
        VARCHAR_32 nickname "參賽者暱稱"
        INTEGER score "個人總積分"
        INTEGER correct_count "答對題數"
        INTEGER streak "目前連續答對數"
        INTEGER total_time_ms "累積作答毫秒數"
        TIMESTAMPTZ joined_at "加入時間"
    }

    quiz_answers {
        SERIAL id PK
        VARCHAR_12 room_pin FK "所屬房間 PIN"
        VARCHAR_64 player_id FK "參賽者 UUID"
        INTEGER question_idx "題目索引"
        CHAR_1 selected_option "選擇選項 (A/B/C/D)"
        BOOLEAN is_correct "是否答對"
        INTEGER elapsed_ms "作答耗時毫秒"
        INTEGER points_awarded "本題獲得積分"
        TIMESTAMPTZ answered_at "送出時間"
    }

    quiz_rooms ||--o{ quiz_groups : "包含組別 (ON DELETE CASCADE)"
    quiz_rooms ||--o{ quiz_players : "包含參賽者 (ON DELETE CASCADE)"
    quiz_rooms ||--o{ quiz_answers : "包含作答紀錄 (ON DELETE CASCADE)"
    quiz_players ||--o{ quiz_answers : "提交答案 (ON DELETE CASCADE)"
```

---

## 6. 計分公式與排行榜排序演算法 (Scoring & Ranking Rules)

### 單題得分公式（僅答對者計分）
$$\text{Points} = 500 + \text{round}\left(500 \times \left(1 - \frac{\min(\text{elapsedMs}, \text{durationMs})}{\text{durationMs}}\right)\right) + \text{StreakBonus}$$

- **基礎分**：答對即得 `500` 分。
- **速度加成**：依剩餘時間比例線性加分，最高 `500` 分（0 秒瞬間作答得 500 分，壓線作答得 0 分）。
- **連續答對獎勵 (`StreakBonus`)**：
  - 連續答對第 2 題：`+100` 分
  - 連續答對第 3 題：`+200` 分
  - 連續答對第 4 題（含）以上：每題固定 `+300` 分（上限）

### 排序優先序
1. **個人排行榜 (`leaderboard`)**：
   - 第一優先：**個人總分 (`score`)** 由高至低
   - 第二優先（同分比序）：**答對題數 (`correctCount`)** 由多至少
   - 第三優先（再同分比序）：**累積總作答時間 (`totalTimeMs`)** 由短至長
2. **組別排行榜 (`groupLeaderboard`)**：
   - 第一優先：**組別平均分 (`avgScore = round(totalScore / memberCount)`)** 由高至低
   - 第二優先（同分比序）：**組別總分 (`totalScore`)** 由高至低
   - 第三優先：**答對總題數 (`totalCorrect`)** 由多至少

---

## 7. 資安防護縱深總覽 (Security Defense-in-Depth)

| 防護面向 | 實作機制與程式碼位置 |
| :--- | :--- |
| **Production Fail-Closed** | [`server.js`](../src/server.js#L43-L46) 與 [`security.js`](../src/security.js#L15-L21) 在 `NODE_ENV=production` 時強制要求設定 `HOST_PASSWORD` 與 `JWT_SECRET`，否則拒絕啟動。 |
| **防時序枚舉與雙層防暴力破解** | [`security.js`](../src/security.js#L98-L132) 於帳號不存在時仍執行 `DUMMY_SCRYPT_HASH` 常數時間比對；`/api/host/login` 同時對「來源 IP」與「目標帳號」進行獨立滑動視窗限流。 |
| **即時憑證撤銷 (`token_version`)** | 停用管理員或重設密碼時，`token_version` 立即遞增並同步至 `adminStateCache`，所有 HTTP API 與 Socket.IO `host:*` 事件透過 `verifyHostAccess` 即時攔截失效 Token。 |
| **題庫樂觀鎖與白名單消毒** | [`validateAndSanitizeQuestion`](../src/security.js#L171-L250) 過濾控制字元、檢查長度並禁止重複選項；編輯題目時強制比對 `version` 防止多人同時覆蓋（`409 Conflict`）。 |
| **嚴格 CSP 與防 XSS** | [`server.js`](../src/server.js#L81-L97) 啟用 `script-src 'self'`、`script-src-attr 'none'`、`connect-src 'self'`；前端 DOM 渲染全面使用 `textContent`。 |
| **防投影洩密保護** | 拆分獨立 `/display/:pin` 唯讀投影路由（後端不傳送 `hostGroups` 密碼，前端隱藏所有管理控制鈕），並在 `/host` 提供「投影模式」安全開關。 |
| **資料庫最小權限** | Cloud Run 透過專用角色 `cyber_quiz_worker` 連線，僅具備 7 張業務資料表與序列之 CRUD 權限，無 `SUPERUSER` 或跨資料庫權限。 |
