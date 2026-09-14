// teleagent-shim (Go) — 方案 A：直连云网关，但用与内核**完全相同的 Go 版本**发起请求，
// 使 TLS ClientHello / HTTP 头顺序 / 传输层行为与 TeleAgent 内核尽可能一致。
//
// 用法:
//   teleagent-shim.exe                 # 默认 127.0.0.1:8788
// 环境变量:
//   TA_PORT            监听端口 (默认 8788)
//   TA_AES_KEY         safeStorage AES key(64 hex)；不设则读 token.key
//   TA_DATA_DIR        TeleAgent 数据目录
//   TA_ACCOUNT         指定账号目录名
//   TA_DEVICE_ID / TA_INSTALL_ID
//   TA_APP_VERSION     默认 2.5.0
//   TA_SK              通道密钥
package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	gatewayURL     = "https://agent.teleai.com.cn/superCowork/sapi/api/v1/chat/completions"
	signPath       = "/superCowork/sapi/api/v1/chat/completions"
	imagesURL      = "https://agent.teleai.com.cn/superCowork/sapi/api/v1/images/generations"
	imagesSignPath = "/superCowork/sapi/api/v1/images/generations"
	imageModel     = "image-generation-pro"
	visionModel    = "vision-standard"
	// 内核标题生成用的 system prompt（从内核二进制里提取，OpenCode 的 title generator）
	titlePrompt = `You are a title generator. You output ONLY a thread title. Nothing else.
<task>
Generate a brief title that would help the user find this conversation later.
Your output must be:
- A single line
- <= 50 characters
- No explanations
</task>
<rules>
- you MUST use the same language as the user message you are summarizing
- Title must be grammatically correct and read naturally - no word salad
- Never include tool names in the title
- Focus on the main topic or question the user needs to retrieve
- Keep exact: technical terms, numbers, filenames, HTTP codes
- NEVER respond to questions, just generate a title for the conversation
- Always output something meaningful, even if the input is minimal.
</rules>`
	titleModel = "chat-lite" // 内核 small_model = NewApi/chat-lite
	scheme         = "superagent-auth-v1"
	defaultSK      = "sk-qvp4m6h9g20uM6PgYP7E"
	b62            = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
)

var (
	port       = envInt("TA_PORT", 8788)
	dataDir    = envOr("TA_DATA_DIR", filepath.Join(home(), ".local", "share", "TeleAgent"))
	appVersion = envOr("TA_APP_VERSION", "2.5.0")
	sk         = envOr("TA_SK", defaultSK)
	kernelURL  = envOr("TA_KERNEL_URL", "http://127.0.0.1:4397")
	apiKey     = os.Getenv("TA_API_KEY") // 非空则要求客户端带此 key
	account    string
	deviceID   string
	installID  string
	aesKey     []byte
	cachedTok  string
	cachedAt   time.Time

	sessionKey  string // 内核本地签名密钥（仅在 TA_REAL_SESSION=1 时需要）
	// 默认【开】：向内核建真会话（带小模型生成的标题），对齐正常对话；
	// 设 TA_REAL_SESSION=0 则纯本地生成精确格式 ID（不依赖 App，但没有标题记录）
	realSession = os.Getenv("TA_REAL_SESSION") != "0"
	// 工具型能力（生图/视觉）默认关闭：它们在平台侧留下两个硬指纹——
	//   ① 模型消耗=0（生图不经模型轮次）
	//   ② 无 security/instruction/review 记录（内核对每个工具调用都会先上报审查）
	enableTools = os.Getenv("TA_ENABLE_TOOLS") == "1"
	sessMu      sync.Mutex
	sessByConv  = map[string]string{} // 对话指纹 -> 内核会话ID
)

func home() string {
	if v := os.Getenv("USERPROFILE"); v != "" {
		return v
	}
	if v := os.Getenv("HOME"); v != "" {
		return v
	}
	return "."
}
func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func envInt(k string, d int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return d
}

// ---------- 账号 / 设备 ----------
func findAccount() string {
	if v := os.Getenv("TA_ACCOUNT"); v != "" {
		return v
	}
	users := filepath.Join(dataDir, "users")
	ents, err := os.ReadDir(users)
	if err != nil {
		return ""
	}
	type cand struct {
		name string
		mt   int64
	}
	var cs []cand
	for _, e := range ents {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), "v1_public_") {
			continue
		}
		tp := filepath.Join(users, e.Name(), "app-auth", "token.json")
		if st, err := os.Stat(tp); err == nil {
			cs = append(cs, cand{e.Name(), st.ModTime().UnixNano()})
		}
	}
	if len(cs) == 0 {
		for _, e := range ents {
			if e.IsDir() && strings.HasPrefix(e.Name(), "v1_public_") {
				return e.Name()
			}
		}
		return ""
	}
	sort.Slice(cs, func(i, j int) bool { return cs[i].mt > cs[j].mt })
	return cs[0].name
}

func loadDeviceMeta() {
	paths := []string{
		filepath.Join(dataDir, "app-auth", "device-meta.json"),
		filepath.Join(envOr("APPDATA", ""), "TeleAgent", "app-auth", "device-meta.json"),
	}
	for _, p := range paths {
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var m struct {
			DeviceID  string `json:"deviceId"`
			InstallID string `json:"installId"`
		}
		if json.Unmarshal(b, &m) == nil && m.DeviceID != "" {
			deviceID = envOr("TA_DEVICE_ID", m.DeviceID)
			installID = envOr("TA_INSTALL_ID", m.InstallID)
			return
		}
	}
	deviceID = os.Getenv("TA_DEVICE_ID")
	installID = os.Getenv("TA_INSTALL_ID")
}

// ---------- AES key / token ----------
func loadAESKey() error {
	if v := os.Getenv("TA_AES_KEY"); v != "" {
		b, err := hex.DecodeString(strings.TrimSpace(v))
		if err == nil && len(b) == 32 {
			aesKey = b
			return nil
		}
	}
	exe, _ := os.Executable()
	cands := []string{
		filepath.Join(filepath.Dir(exe), "token.key"),
		filepath.Join(mustCwd(), "token.key"),
		filepath.Join(home(), "Desktop", "token.key"),
		filepath.Join(home(), "Desktop", "teleagent-proxy", "scripts", "token.key"),
		filepath.Join(dataDir, "token.key"),
	}
	for _, p := range cands {
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		h := strings.TrimSpace(string(b))
		if len(h) == 64 {
			if k, err := hex.DecodeString(h); err == nil {
				aesKey = k
				return nil
			}
		}
	}
	return fmt.Errorf("缺少 AES key：设置 TA_AES_KEY，或把 64 位 hex 写入 token.key")
}
func mustCwd() string { d, _ := os.Getwd(); return d }

// ---------- 内核本地会话（让 X-Session-Id 是真实存在的会话） ----------
func exeDir() string { e, _ := os.Executable(); return filepath.Dir(e) }

func loadSessionKey() string {
	if v := os.Getenv("TA_SESSION_KEY"); v != "" {
		return strings.TrimSpace(v)
	}
	for _, p := range []string{
		filepath.Join(exeDir(), "session.key"),
		filepath.Join(mustCwd(), "session.key"),
		filepath.Join(dataDir, "session.key"),
	} {
		if b, err := os.ReadFile(p); err == nil {
			if s := strings.TrimSpace(string(b)); s != "" {
				return s
			}
		}
	}
	return ""
}

func localSignHeaders(method, pathWithQuery string) map[string]string {
	ts := strconv.FormatInt(time.Now().UnixMilli(), 10) // 毫秒
	rnd := make([]byte, 12)
	rand.Read(rnd)
	nonce := hex.EncodeToString(rnd)
	payload := strings.Join([]string{"local-v1", strings.ToUpper(method), pathWithQuery, ts, nonce}, "\n")
	mac := hmac.New(sha256.New, []byte(sessionKey))
	mac.Write([]byte(payload))
	return map[string]string{
		"X-SA-Sign-Version": "local-v1",
		"X-SA-Timestamp":    ts,
		"X-SA-Nonce":        nonce,
		"X-SA-Signature":    base64.RawURLEncoding.EncodeToString(mac.Sum(nil)),
	}
}

// 在本地内核里真建一个会话，返回它的 id（失败返回 ""）
func kernelSessionOnce(title string) (string, int) {
	if sessionKey == "" {
		return "", 0
	}
	if title == "" {
		title = "新对话"
	}
	tb, _ := json.Marshal(map[string]string{"title": title})
	body := string(tb)
	req, err := http.NewRequest("POST", kernelURL+"/session", strings.NewReader(body))
	if err != nil {
		return "", 0
	}
	for k, v := range localSignHeaders("POST", "/session") {
		req.Header.Set(k, v)
	}
	req.Header.Set("Content-Type", "application/json")
	cl := &http.Client{Timeout: 10 * time.Second}
	resp, err := cl.Do(req)
	if err != nil {
		return "", 0
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return "", resp.StatusCode
	}
	var out struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(b, &out) == nil && strings.HasPrefix(out.ID, "ses_") {
		return out.ID, 200
	}
	return "", 200
}

// 密钥失效（App 重启过）→ 重跑 get-session-key.py 重新抓一次
func refreshSessionKeyViaPython() bool {
	py := ""
	cands := []string{
		filepath.Join(home(), ".local", "share", "TeleAgent", "runtimes", "python", "python.exe"),
		"python",
	}
	for _, c := range cands {
		if c == "python" {
			py = c
			break
		}
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			py = c
			break
		}
	}
	if py == "" {
		return false
	}
	cmd := exec.Command(py, filepath.Join(exeDir(), "get-session-key.py"))
	cmd.Dir = exeDir()
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		return false
	}
	if k := loadSessionKey(); k != "" {
		sessionKey = k
		log.Printf("[go-shim] 会话密钥已重新获取（App 重启过）")
		return true
	}
	return false
}

func createKernelSession(title string) string {
	if !realSession {
		return ""
	}
	id, code := kernelSessionOnce(title)
	if id != "" {
		return id
	}
	if code == 401 || code == 403 {
		if refreshSessionKeyViaPython() {
			if id2, _ := kernelSessionOnce(title); id2 != "" {
				return id2
			}
		}
	}
	return ""
}

func sha1hex(b []byte) string { s := sha1.Sum(b); return hex.EncodeToString(s[:]) }

// 对话指纹：取第一条 user 消息（跨轮稳定）
func convKey(msgs []json.RawMessage) string {
	for _, m := range msgs {
		var h struct {
			Role string `json:"role"`
		}
		if json.Unmarshal(m, &h) == nil && h.Role == "user" {
			return sha1hex(m)
		}
	}
	all := make([][]byte, 0, len(msgs))
	for _, m := range msgs {
		all = append(all, []byte(m))
	}
	return sha1hex(bytes.Join(all, nil))
}

// 为一个对话拿到（或创建）会话 ID：优先真实内核会话，失败则形状对齐的合成 ID
func sessionForConv(key, firstUserText string) string {
	sessMu.Lock()
	defer sessMu.Unlock()
	if id, ok := sessByConv[key]; ok {
		return id
	}
	// 先按内核的方式建会话（标题给个占位），随后异步用小模型生成标题再 PATCH，
	// 这样 X-Session-Id 与标题生成请求用的都是同一个会话。
	id := createKernelSession("新对话")
	real := id != ""
	if !real {
		id = kernID("ses")
	}
	sessByConv[key] = id
	short := key
	if len(short) > 8 {
		short = short[:8]
	}
	log.Printf("[go-shim] new session for conversation %s -> %s (real=%v)", short, id, real)
	if real && firstUserText != "" {
		go func(sid, txt string) {
			if t := genTitle(txt, sid); t != "" {
				patchKernelSessionTitle(sid, t)
				log.Printf("[go-shim] 标题已生成: %s -> %q", sid, t)
			}
		}(id, firstUserText)
	}
	return id
}

// 取第一条 user 消息的纯文本（给标题生成用）
func firstUserText(msgs []json.RawMessage) string {
	for _, m := range msgs {
		var h struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		}
		if json.Unmarshal(m, &h) != nil || h.Role != "user" {
			continue
		}
		var s string
		if json.Unmarshal(h.Content, &s) == nil {
			return s
		}
		var arr []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(h.Content, &arr) == nil {
			var sb strings.Builder
			for _, p := range arr {
				if p.Type == "text" {
					sb.WriteString(p.Text)
				}
			}
			if sb.Len() > 0 {
				return sb.String()
			}
		}
	}
	return ""
}

func messagesOf(body []byte) []json.RawMessage {
	var r struct {
		Messages []json.RawMessage `json:"messages"`
	}
	_ = json.Unmarshal(body, &r)
	return r.Messages
}

// 聊天：按 messages 的第一个 user 消息做对话指纹
func sessionForChat(body []byte) string {
	msgs := messagesOf(body)
	return sessionForConv(convKey(msgs), firstUserText(msgs))
}

// 生图：用 prompt 做指纹
func sessionForImages(body []byte) string {
	var r struct {
		Prompt string `json:"prompt"`
	}
	_ = json.Unmarshal(body, &r)
	if r.Prompt == "" {
		return sessionForConv(sha1hex([]byte("images")), "")
	}
	return sessionForConv(sha1hex([]byte(r.Prompt)), r.Prompt)
}

// 判断聊天请求里是否带了图片（带了就走 tool_call，与内核的 image_understanding 一致）
func hasImageContent(body []byte) bool {
	for _, m := range messagesOf(body) {
		var h struct {
			Content json.RawMessage `json:"content"`
		}
		if json.Unmarshal(m, &h) != nil {
			continue
		}
		c := strings.TrimSpace(string(h.Content))
		if len(c) > 0 && c[0] == '[' && (strings.Contains(c, "image_url") || strings.Contains(c, "image")) {
			return true
		}
	}
	return false
}

func decryptToken() (string, error) {
	tp := filepath.Join(dataDir, "users", account, "app-auth", "token.json")
	b, err := os.ReadFile(tp)
	if err != nil {
		return "", err
	}
	var tj struct {
		EncryptedToken string `json:"encryptedToken"`
	}
	if err := json.Unmarshal(b, &tj); err != nil {
		return "", err
	}
	blob, err := base64.StdEncoding.DecodeString(tj.EncryptedToken)
	if err != nil || len(blob) < 31 {
		return "", fmt.Errorf("encryptedToken 解析失败")
	}
	// v10 | 12B nonce | ct | 16B tag
	block, err := aes.NewCipher(aesKey)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	pt, err := gcm.Open(nil, blob[3:15], blob[15:], nil)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(pt)), nil
}

func getToken(force bool) (string, error) {
	if !force && cachedTok != "" && time.Since(cachedAt) < 10*time.Minute {
		return cachedTok, nil
	}
	t, err := decryptToken()
	if err != nil {
		return "", err
	}
	cachedTok, cachedAt = t, time.Now()
	return t, nil
}

// ---------- 签名 ----------
func sign(token, method, path string, ts int64, nonce string, body []byte) string {
	// K = JWT 的第三段
	parts := strings.SplitN(token, ":", 2)
	jwt := token
	if len(parts) == 2 {
		jwt = parts[1]
	}
	segs := strings.Split(jwt, ".")
	K := ""
	if len(segs) >= 3 {
		K = segs[2]
	}
	// 第 1 轮（分隔符 "/"）
	m1 := strings.Join([]string{scheme, token, installID, strconv.FormatInt(ts, 10), nonce}, "/")
	h1 := hmac.New(sha256.New, []byte(K))
	h1.Write([]byte(m1))
	sig1 := hex.EncodeToString(h1.Sum(nil))
	// 第 2 轮（分隔符 "\n"）
	bh := sha256.Sum256(body)
	bodyHash := hex.EncodeToString(bh[:])
	m2 := strings.Join([]string{scheme, method, path, strconv.FormatInt(ts, 10), nonce, appVersion, bodyHash}, "\n")
	h2 := hmac.New(sha256.New, []byte(sig1))
	h2.Write([]byte(m2))
	return hex.EncodeToString(h2.Sum(nil))
}

// ---------- ID（精确复刻内核算法） ----------
//
// 实测（10 个样本完全吻合）：
//   ses 的 12 位 hex 值 = ~((ms << 12) | 1) & 0xFFFFFFFFFFFF
//   即 v + (ms<<12) ≡ 2^48 - 2  (mod 2^48)，低 12 位固定 0xFFE
//   后面跟 14 位 base62 随机串
//
// 实测样本：
//   ms=1789182790685 -> f6c6533e2ffe
//   ms=1789182796073 -> f6c651ed6ffe
func randBase62(n int) string {
	sb := make([]byte, n)
	for i := range sb {
		v, err := rand.Int(rand.Reader, big.NewInt(62))
		if err != nil {
			sb[i] = '0'
			continue
		}
		sb[i] = b62[v.Int64()]
	}
	return string(sb)
}
// 用内核小模型（chat-lite）生成标题，模拟内核标题生成行为，
// 避免出现写死的 "pi" 这种一看就不是正常对话的标题。
// 失败返回 ""（调用方会用兜底标题）。
func genTitle(firstUserText, sessionID string) string {
	if firstUserText == "" {
		return ""
	}
	if len([]rune(firstUserText)) > 4000 {
		firstUserText = string([]rune(firstUserText)[:4000])
	}
	payload, _ := json.Marshal(map[string]any{
		"model": titleModel,
		"messages": []map[string]any{
			{"role": "system", "content": titlePrompt},
			{"role": "user", "content": "Generate a title for this conversation:\n\n" + firstUserText},
		},
		"max_tokens": 64,
		"stream":     false,
	})
	if sessionID == "" {
		sessionID = kernID("ses")
	}
	o := gwOpts{url: gatewayURL, signPath: signPath, runUnit: "agent_loop", ua: "super-agent/1.0", chat: true}
	resp, err := gwSend(o, sessionID, payload)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return ""
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if json.Unmarshal(b, &out) != nil || len(out.Choices) == 0 {
		return ""
	}
	t := strings.TrimSpace(out.Choices[0].Message.Content)
	if i := strings.IndexByte(t, '\n'); i > 0 {
		t = strings.TrimSpace(t[:i])
	}
	t = strings.Trim(t, "\"'` ")
	if len([]rune(t)) > 60 {
		t = string([]rune(t)[:60])
	}
	return t
}

// 把标题写回内核会话（PATCH /session/:id）
func patchKernelSessionTitle(id, title string) {
	if sessionKey == "" || id == "" || title == "" {
		return
	}
	tb, _ := json.Marshal(map[string]string{"title": title})
	path := "/session/" + id
	req, err := http.NewRequest("PATCH", kernelURL+path, strings.NewReader(string(tb)))
	if err != nil {
		return
	}
	for k, v := range localSignHeaders("PATCH", path) {
		req.Header.Set(k, v)
	}
	req.Header.Set("Content-Type", "application/json")
	cl := &http.Client{Timeout: 10 * time.Second}
	resp, err := cl.Do(req)
	if err != nil {
		return
	}
	resp.Body.Close()
}

// 内核 ID（ses 为精确算法；msg 的形状相同，内部编码未完全逆向）
func kernID(prefix string) string {
	return kernIDAt(prefix, uint64(time.Now().UnixMilli()))
}

func kernIDAt(prefix string, ms uint64) string {
	ctr := uint64(1)
	if prefix == "msg" {
		ctr = 0xFFE
	}
	v := (^(ms<<12 | ctr)) & 0xFFFFFFFFFFFF
	return fmt.Sprintf("%s_%012x%s", prefix, v, randBase62(14))
}

func uuidv7() string {
	b := make([]byte, 16)
	rand.Read(b)
	ms := time.Now().UnixMilli()
	b[0] = byte(ms >> 40)
	b[1] = byte(ms >> 32)
	b[2] = byte(ms >> 24)
	b[3] = byte(ms >> 16)
	b[4] = byte(ms >> 8)
	b[5] = byte(ms)
	b[6] = (b[6] & 0x0f) | 0x70
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	return fmt.Sprintf("%s-%s-%s-%s-%s", h[0:8], h[8:12], h[12:16], h[16:20], h[20:])
}

// ---------- 转发 ----------
var client = &http.Client{} // 默认 Transport：与内核同样的 Go net/http + crypto/tls

// 网关请求模板：不同端点要的头不完全一样
//   chat=true  → 聊天那套（带 Authorization/Accept/Cache-Control/Connection + super-agent UA）
//   chat=false → 工具调用那套（images 端点：不带上面那几个头，UA 用 Go 默认）
type gwOpts struct {
	url      string
	signPath string
	runUnit  string
	ua       string // "" = 不设，用 Go 默认 Go-http-client/1.1
	chat     bool
}

func gwDo(tok string, o gwOpts, sesID string, body []byte) (*http.Response, error) {
	ts := time.Now().Unix()
	nonce := uuid4()
	sig := sign(tok, "POST", o.signPath, ts, nonce, body)
	req, err := http.NewRequest("POST", o.url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	h := req.Header
	h.Set("Content-Type", "application/json")
	if o.ua != "" {
		h.Set("User-Agent", o.ua)
	}
	h.Set("X-App-Version", appVersion)
	h.Set("X-Message-Id", kernID("msg"))
	h.Set("X-Request-Id", uuidv7())
	h.Set("X-Route-Target", "ops-gateway")
	h.Set("X-Session-Id", sesID)
	h.Set("X-Superagent-Device-Id", deviceID)
	h.Set("X-Superagent-Install-Id", installID)
	h.Set("X-Superagent-Nonce", nonce)
	h.Set("X-Superagent-Sign-Version", "v1")
	h.Set("X-Superagent-Signature", sig)
	h.Set("X-Superagent-Timestamp", strconv.FormatInt(ts, 10))
	h.Set("X-Teleai-Client-Type", "desktop")
	h.Set("X-Teleai-Root-Session-Id", sesID)
	h.Set("X-Teleai-Run-Unit-Type", o.runUnit)
	h.Set("X-Teleai-Upstream-Request-Id", uuid4())
	h.Set("X-Token", tok)
	if o.chat {
		h.Set("Accept", "text/event-stream")
		h.Set("Authorization", "Bearer "+sk)
		h.Set("Cache-Control", "no-cache")
		h.Set("Connection", "keep-alive")
	}
	return client.Do(req)
}

// 统一发送 + 401/403 自动重取 token 重试一次
func gwSend(o gwOpts, sesID string, body []byte) (*http.Response, error) {
	token, err := getToken(false)
	if err != nil {
		return nil, err
	}
	resp, err := gwDo(token, o, sesID, body)
	if err == nil && (resp.StatusCode == 401 || resp.StatusCode == 403) {
		resp.Body.Close()
		if t2, e2 := getToken(true); e2 == nil {
			resp, err = gwDo(t2, o, sesID, body)
		}
	}
	return resp, err
}

// 把上游响应（有可能是 SSE）原样回给客户端
func pipeBack(w http.ResponseWriter, resp *http.Response, defCT string) {
	defer resp.Body.Close()
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = defCT
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(resp.StatusCode)
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 16*1024)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			w.Write(buf[:n])
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil {
			break
		}
	}
}

// 带图请求要改用视觉模型（内核的 image_understanding 用的是 vision-standard + temperature 0.2）
func rewriteForVision(body []byte) []byte {
	in := map[string]any{}
	if err := json.Unmarshal(body, &in); err != nil {
		// 解析失败就不改，风险自负
		if in == nil {
			return body
		}
	}
	in["model"] = visionModel
	if _, ok := in["temperature"]; !ok {
		in["temperature"] = 0.2
	}
	out, err := json.Marshal(in)
	if err != nil {
		return body
	}
	return out
}

// 聊天（带图自动切 tool_call + 视觉模型，与内核 image_understanding 一致）
func forwardChat(body []byte, w http.ResponseWriter) {
	runUnit := "agent_loop"
	if hasImageContent(body) {
		if !enableTools {
			serveErr(w, 403, "视觉（图片输入）已暂时关闭：该能力对平台表现为 tool_call，"+
				"但缺少内核的 security/instruction/review 记录，已被用于风控识别。"+
				"确需使用请设 TA_ENABLE_TOOLS=1（自担风险）。")
			return
		}
		runUnit = "tool_call"
		body = rewriteForVision(body)
		log.Printf("[go-shim] 检测到图片输入 -> model=%s, X-Teleai-Run-Unit-Type=tool_call", visionModel)
	}
	o := gwOpts{url: gatewayURL, signPath: signPath, runUnit: runUnit, ua: "super-agent/1.0", chat: true}
	resp, err := gwSend(o, sessionForChat(body), body)
	if err != nil {
		serveErr(w, 502, err.Error())
		return
	}
	pipeBack(w, resp, "text/event-stream")
}

// 生图 / 图生图：转发到平台 /images/generations
func forwardImages(body []byte, w http.ResponseWriter) {
	if !enableTools {
		serveErr(w, 403, "生图已暂时关闭：直连 /images/generations 会在平台留下"+
			"「模型消耗=0 + 无 security/instruction/review」的记录，是明显的非 agent 调用。"+
			"确需使用请设 TA_ENABLE_TOOLS=1（自担风险）。")
		return
	}
	// 先解成 map 保留客户端字段（图生图参考图等），再强制为内核那套固定字段
	in := map[string]any{}
	if err := json.Unmarshal(body, &in); err != nil {
		serveErr(w, 400, "invalid json: "+err.Error())
		return
	}
	if _, ok := in["prompt"]; !ok || in["prompt"] == "" {
		serveErr(w, 400, "prompt is required")
		return
	}
	in["model"] = imageModel
	if _, ok := in["response_format"]; !ok {
		in["response_format"] = "b64_json"
	}
	if _, ok := in["seed"]; !ok {
		in["seed"] = -1
	}
	if _, ok := in["sequential_image_generation"]; !ok {
		in["sequential_image_generation"] = "disabled"
	}
	if _, ok := in["size"]; !ok {
		in["size"] = "2048x2048"
	}
	in["stream"] = false
	if _, ok := in["watermark"]; !ok {
		in["watermark"] = false
	}
	out, err := json.Marshal(in)
	if err != nil {
		serveErr(w, 500, err.Error())
		return
	}
	o := gwOpts{url: imagesURL, signPath: imagesSignPath, runUnit: "tool_call", ua: "", chat: false}
	resp, err := gwSend(o, sessionForImages(out), out)
	if err != nil {
		serveErr(w, 502, err.Error())
		return
	}
	pipeBack(w, resp, "application/json")
}

func uuid4() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	return fmt.Sprintf("%s-%s-%s-%s-%s", h[0:8], h[8:12], h[12:16], h[16:20], h[20:])
}

func serveErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"message": msg}})
}

func main() {
	account = findAccount()
	loadDeviceMeta()
	if err := loadAESKey(); err != nil {
		log.Printf("[warn] %v", err)
	}
	sessionKey = ""
	if realSession {
		sessionKey = loadSessionKey()
	}
	mux := http.NewServeMux()
	// 可选的本地 key 校验（设了 TA_API_KEY 才开）
	authOK := func(w http.ResponseWriter, r *http.Request) bool {
		if apiKey == "" {
			return true
		}
		if strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")) == apiKey {
			return true
		}
		serveErr(w, 401, "invalid api key")
		return false
	}
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		if !authOK(w, r) {
			return
		}
		models := []map[string]any{}
		for _, id := range []string{"chat-pro", "chat-lite", "chat-flash"} {
			models = append(models, map[string]any{"id": id, "object": "model", "owned_by": "teleai"})
		}
		models = append(models, map[string]any{"id": imageModel, "object": "model", "owned_by": "teleai"})
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"object": "list", "data": models})
	})
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		if !authOK(w, r) {
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			serveErr(w, 400, err.Error())
			return
		}
		forwardChat(body, w)
	})
	// 生图 / 图生图（兼容 OpenAI 图片接口）
	mux.HandleFunc("/v1/images/generations", func(w http.ResponseWriter, r *http.Request) {
		if !authOK(w, r) {
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			serveErr(w, 400, err.Error())
			return
		}
		forwardImages(body, w)
	})
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	log.Printf("[go-shim] listening on http://%s/v1", addr)
	log.Printf("[go-shim] account=%s deviceId=%s installId=%s", account, deviceID, installID)
	log.Printf("[go-shim] 生图/视觉（工具型能力）: %s", map[bool]string{true: "开（TA_ENABLE_TOOLS=1，有风控风险）", false: "关（默认，纯聊天不受影响）"}[enableTools])
	if apiKey != "" {
		log.Printf("[go-shim] apiKey 校验: 开（TA_API_KEY）")
	} else {
		log.Printf("[go-shim] apiKey 校验: 关（本地任意 key 均可）")
	}
	if realSession {
		if sessionKey != "" {
			log.Printf("[go-shim] 内核会话: 开（会向内核建真会话；需 App 在运行）")
		} else {
			log.Printf("[go-shim] 内核会话: 开但无 session.key（跑 get-session-key.py 可补）")
		}
	} else {
		log.Printf("[go-shim] 内核会话: 关（本地精确 ID，不依赖 App；设 TA_REAL_SESSION=1 可开）")
	}
	if _, err := getToken(false); err != nil {
		log.Printf("[go-shim] token load failed: %v", err)
	} else {
		log.Printf("[go-shim] token loaded OK")
	}
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}
