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
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	gatewayURL = "https://agent.teleai.com.cn/superCowork/sapi/api/v1/chat/completions"
	signPath   = "/superCowork/sapi/api/v1/chat/completions"
	scheme     = "superagent-auth-v1"
	defaultSK  = "sk-qvp4m6h9g20uM6PgYP7E"
	b62        = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
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

	sessionKey  string   // 内核本地签名密钥（用于创建真会话）
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
func createKernelSession() string {
	if sessionKey == "" {
		return ""
	}
	body := `{"title":"pi"}`
	req, err := http.NewRequest("POST", kernelURL+"/session", strings.NewReader(body))
	if err != nil {
		return ""
	}
	for k, v := range localSignHeaders("POST", "/session") {
		req.Header.Set(k, v)
	}
	req.Header.Set("Content-Type", "application/json")
	cl := &http.Client{Timeout: 10 * time.Second}
	resp, err := cl.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var out struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(b, &out) == nil && strings.HasPrefix(out.ID, "ses_") {
		return out.ID
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
func sessionFor(body []byte) string {
	var r struct {
		Messages []json.RawMessage `json:"messages"`
	}
	_ = json.Unmarshal(body, &r)
	key := convKey(r.Messages)

	sessMu.Lock()
	defer sessMu.Unlock()
	if id, ok := sessByConv[key]; ok {
		return id
	}
	id := createKernelSession()
	real := id != ""
	if !real {
		id = kernID("ses")
	}
	sessByConv[key] = id
	log.Printf("[go-shim] new session for conversation %s -> %s (real=%v)", key[:8], id, real)
	return id
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

// ---------- ID（形状对齐内核） ----------
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

func kernID(prefix string) string {
	inv := ^uint32(time.Now().UnixMilli())
	rb := make([]byte, 3)
	rand.Read(rb)
	hexPart := fmt.Sprintf("%08x%s", inv, hex.EncodeToString(rb))
	if len(hexPart) > 12 {
		hexPart = hexPart[:12]
	}
	for len(hexPart) < 12 {
		hexPart += "0"
	}
	return prefix + "_" + hexPart + randBase62(14)
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

func forward(body []byte, w http.ResponseWriter, streaming bool) {
	token, err := getToken(false)
	if err != nil {
		serveErr(w, 500, err.Error())
		return
	}
	sesID := sessionFor(body) // 真内核会话（拿不到则退化为合成 ID）
	doReq := func(tok string, sesID string) (*http.Response, error) {
		ts := time.Now().Unix()
		nonce := uuid4()
		sig := sign(tok, "POST", signPath, ts, nonce, body)
		req, err := http.NewRequest("POST", gatewayURL, strings.NewReader(string(body)))
		if err != nil {
			return nil, err
		}
		h := req.Header
		h.Set("Accept", "text/event-stream")
		h.Set("Authorization", "Bearer "+sk)
		h.Set("Cache-Control", "no-cache")
		h.Set("Connection", "keep-alive")
		h.Set("Content-Type", "application/json")
		h.Set("User-Agent", "super-agent/1.0")
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
		h.Set("X-Teleai-Run-Unit-Type", "agent_loop")
		h.Set("X-Teleai-Upstream-Request-Id", uuid4())
		h.Set("X-Token", tok)
		// Accept-Encoding 交给 Transport 自动加（与内核一致，出现在最后）
		return client.Do(req)
	}
	resp, err := doReq(token, sesID)
	if err == nil && (resp.StatusCode == 401 || resp.StatusCode == 403) {
		resp.Body.Close()
		if t2, e2 := getToken(true); e2 == nil {
			resp, err = doReq(t2, sesID)
		}
	}
	if err != nil {
		serveErr(w, 502, err.Error())
		return
	}
	defer resp.Body.Close()
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "text/event-stream"
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
	sessionKey = loadSessionKey()
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
		forward(body, w, true)
	})
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	log.Printf("[go-shim] listening on http://%s/v1", addr)
	log.Printf("[go-shim] account=%s deviceId=%s installId=%s", account, deviceID, installID)
	if apiKey != "" {
		log.Printf("[go-shim] apiKey 校验: 开（TA_API_KEY）")
	} else {
		log.Printf("[go-shim] apiKey 校验: 关（本地任意 key 均可）")
	}
	if sessionKey != "" {
		log.Printf("[go-shim] 内核会话支持: 开（session.key 已加载，X-Session-Id 为真实会话）")
	} else {
		log.Printf("[go-shim] 内核会话支持: 关（未见 session.key，X-Session-Id 用合成 ID；如需真会话请跑 get-session-key.py）")
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
