import { useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  Eye,
  EyeOff,
} from "lucide-react";
import {
  loginPassword,
  resetService,
  serviceNames,
  type LoginTarget,
  type PasswordLoginResult,
  type Service,
} from "../lib/api";
import { Button, Modal } from "./ui";

const services: Service[] = ["course", "treehole", "campuscard"];
const uses: Partial<Record<Service, string>> = {
  course: "课程、作业与资料",
  treehole: "正式成绩",
  campuscard: "余额与收支",
};

export default function PasswordLogin({
  service,
  onClose,
  methods,
}: {
  service: LoginTarget;
  onClose: () => void;
  methods: (busy: boolean) => ReactNode;
}) {
  const client = useQueryClient();
  const [username, setUsername] = useState("");
  const password = useRef<HTMLInputElement>(null);
  const otp = useRef<HTMLInputElement>(null);
  const [hasPassword, setHasPassword] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [selected, setSelected] = useState<Service[]>(
    service === "all" ? services : [service],
  );
  const [results, setResults] = useState<
    Partial<Record<Service, PasswordLoginResult>>
  >({});
  const [current, setCurrent] = useState<Service>();
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const busy = !!current;
  const succeeded = selected.filter((s) => results[s]?.success);
  const remaining = selected.filter((s) => !results[s]?.success);
  const complete = selected.length > 0 && remaining.length === 0;
  const available = service === "bdkj" ? [service] : services;

  function resetResults() {
    setResults({});
    setError("");
  }
  async function submit() {
    if (busyRef.current || !remaining.length) return;
    if (!username.trim() || !password.current?.value) {
      setError("请输入学号和统一身份认证密码");
      return;
    }
    const code = otp.current?.value.trim() ?? "";
    if (code && !/^\d{4,8}$/.test(code)) {
      setError("动态口令应为 4–8 位数字");
      otp.current?.focus();
      return;
    }
    busyRef.current = true;
    setError("");
    let secret = password.current.value;
    const next = { ...results };
    try {
      for (const target of remaining) {
        setCurrent(target);
        try {
          next[target] = await loginPassword({
            service: target,
            username: username.trim(),
            password: secret,
            otp: code,
            remember,
          });
        } catch (e) {
          next[target] = {
            service: target,
            success: false,
            message: e instanceof Error ? e.message : String(e),
          };
        }
        setResults({ ...next });
        if (next[target]?.success) {
          resetService(client, target);
          void client.invalidateQueries({ queryKey: ["sessions"] });
        }
      }
      if (selected.every((s) => next[s]?.success)) {
        if (password.current) password.current.value = "";
        if (otp.current) otp.current.value = "";
        setHasPassword(false);
        setShowPassword(false);
      }
    } finally {
      secret = "";
      busyRef.current = false;
      setCurrent(undefined);
    }
  }

  return (
    <Modal
      title={service === "all" ? "登录 OnePKU" : `连接${serviceNames[service]}`}
      description="使用北大统一身份认证，一次填写即可连接所选服务。"
      open
      onClose={onClose}
      dismissible={!busy}
    >
      {methods(busy)}
      <form
        className="password-login"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {!complete && (
          <>
            <label htmlFor="login-username">学号 / 职工号</label>
            <input
              id="login-username"
              autoComplete="username"
              inputMode="numeric"
              value={username}
              disabled={busy}
              maxLength={128}
              onChange={(e) => {
                setUsername(e.target.value);
                resetResults();
              }}
              required
            />
            <label htmlFor="login-password">统一身份认证密码</label>
            <div className="password-field">
              <input
                id="login-password"
                ref={password}
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                disabled={busy}
                maxLength={512}
                onChange={(e) => {
                  setHasPassword(!!e.target.value);
                  setError("");
                }}
                required
              />
              <button
                className="icon-button"
                type="button"
                aria-label={showPassword ? "隐藏密码" : "显示密码"}
                disabled={busy}
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            <details className="login-otp">
              <summary>已启用动态口令</summary>
              <label htmlFor="login-otp">当前动态口令</label>
              <input
                id="login-otp"
                ref={otp}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={8}
                disabled={busy}
                placeholder="未启用可留空"
              />
            </details>
          </>
        )}
        <fieldset className="login-services" disabled={busy || complete}>
          <legend>连接服务</legend>
          {available.map((target) => {
            const result = results[target];
            return (
              <div key={target} className="login-service">
                <label>
                  <input
                    type="checkbox"
                    checked={selected.includes(target)}
                    onChange={(e) =>
                      setSelected((prev) =>
                        e.target.checked
                          ? [...prev, target]
                          : prev.filter((s) => s !== target),
                      )
                    }
                  />
                  <span>
                    <strong>{serviceNames[target]}</strong>
                    <small>{uses[target]}</small>
                  </span>
                </label>
                <span
                  className={`login-result ${result?.success ? "connected" : result ? "failed" : ""}`}
                  role="status"
                >
                  {current === target ? (
                    <>
                      <LoaderCircle size={15} className="spin" />
                      连接中
                    </>
                  ) : result?.success ? (
                    <>
                      <CheckCircle2 size={15} />
                      已连接
                    </>
                  ) : result ? (
                    <>
                      <CircleAlert size={15} />
                      未连接
                    </>
                  ) : null}
                </span>
                {result?.message && (
                  <p className="inline-error">{result.message}</p>
                )}
                {result?.warning && <p className="subtle">{result.warning}</p>}
              </div>
            );
          })}
        </fieldset>
        {!complete && (
          <label className="remember-login">
            <input
              type="checkbox"
              checked={remember}
              disabled={busy}
              onChange={(e) => setRemember(e.target.checked)}
            />
            记住密码，会话过期时自动重登
          </label>
        )}
        <p className="login-privacy">
          {remember
            ? "密码仅保存在本机系统钥匙串。动态口令不保存；学校要求额外验证时仍需手动完成。"
            : "密码仅用于本次登录，不保存到本机；登录会话会保留。"}
        </p>
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        {complete ? (
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        ) : (
          <div className="login-actions">
            <Button
              variant="primary"
              type="submit"
              disabled={
                busy || !username.trim() || !hasPassword || !remaining.length
              }
            >
              {busy
                ? `正在连接${serviceNames[current!]}…`
                : Object.keys(results).length
                  ? "重试未连接的服务"
                  : "登录并连接"}
            </Button>
            {succeeded.length > 0 && (
              <Button disabled={busy} onClick={onClose}>
                使用已连接的服务
              </Button>
            )}
          </div>
        )}
      </form>
    </Modal>
  );
}
