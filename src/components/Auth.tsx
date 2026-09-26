import { useEffect, useState, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, RefreshCw } from "lucide-react";
import {
  action,
  serviceNames,
  resetService,
  type Service,
  type LoginTarget,
} from "../lib/api";
import { Button, Modal } from "./ui";
import PasswordLogin from "./PasswordLogin";
export default function Auth({
  service,
  scope,
  onClose,
}: {
  service: LoginTarget;
  scope?: "treehole" | "timetable";
  onClose: () => void;
}) {
  const [method, setMethod] = useState<"password" | "qr">("password");
  const [qrService, setQrService] = useState<Service>(
    service === "all" ? "course" : service,
  );
  const methods = (busy = false) => (
    <div className="auth-methods" aria-label="登录方式">
      <button
        type="button"
        aria-pressed={method === "password"}
        disabled={busy}
        onClick={() => setMethod("password")}
      >
        账号密码
      </button>
      <button
        type="button"
        aria-pressed={method === "qr"}
        disabled={busy}
        onClick={() => setMethod("qr")}
      >
        扫码登录
      </button>
    </div>
  );
  if (!scope && method === "password")
    return (
      <PasswordLogin service={service} onClose={onClose} methods={methods} />
    );
  return (
    <QrAuth
      key={`${qrService}:${scope}`}
      service={qrService}
      scope={scope}
      onClose={onClose}
      methods={
        !scope && (
          <>
            {methods()}
            {service === "all" && (
              <label className="qr-service-choice">
                扫码连接
                <select
                  aria-label="扫码连接的服务"
                  value={qrService}
                  onChange={(e) => setQrService(e.target.value as Service)}
                >
                  {(["course", "treehole", "campuscard"] as Service[]).map(
                    (s) => (
                      <option key={s} value={s}>
                        {serviceNames[s]}
                      </option>
                    ),
                  )}
                </select>
              </label>
            )}
          </>
        )
      }
    />
  );
}
function QrAuth({
  service,
  scope,
  onClose,
  methods,
}: {
  service: Service;
  scope?: "treehole" | "timetable";
  onClose: () => void;
  methods?: ReactNode;
}) {
  const client = useQueryClient();
  const [qr, setQr] = useState<{ id: string; qr: string }>();
  const [state, setState] = useState("idle");
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const active = useRef(true);
  const requestVersion = useRef(0);
  const smsInput = useRef<HTMLInputElement>(null);
  const currentId = useRef<string | undefined>(undefined);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      requestVersion.current++;
      if (currentId.current)
        void action({ kind: "authCancel", id: currentId.current });
    };
  }, []);
  // 扫码登录打开即取二维码，不用先点一次按钮；短信验证不自动发送。
  useEffect(() => {
    if (scope) return;
    void begin();
    // begin 只依赖 service，而 service 变化会重新挂载组件。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  useEffect(() => {
    if (!cooldown) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);
  async function begin() {
    const version = ++requestVersion.current;
    setState("loading");
    setError("");
    if (currentId.current)
      void action({ kind: "authCancel", id: currentId.current });
    try {
      const q = await action<{ id: string; qr: string }>({
        kind: "authBegin",
        service,
      });
      if (!active.current || version !== requestVersion.current) {
        void action({ kind: "authCancel", id: q.id });
        return;
      }
      currentId.current = q.id;
      setQr(q);
      setState("pending");
    } catch (e) {
      if (!active.current || version !== requestVersion.current) return;
      setError((e as Error).message);
      setState("failed");
    }
  }
  useEffect(() => {
    if (!qr || state !== "pending") return;
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const p = await action<{ state: string }>({
          kind: "authPoll",
          id: qr.id,
        });
        if (!alive) return;
        if (p.state === "success") {
          setState("success");
          resetService(client, service);
          void client.invalidateQueries({ queryKey: ["sessions"] });
        } else if (p.state === "pending") setQr({ ...qr });
        else setState(p.state);
      } catch (e) {
        if (alive) {
          setError((e as Error).message);
          setState("failed");
        }
      }
    }, 2800);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [qr, state, client, service]);
  async function send() {
    setError("");
    setState("loading");
    try {
      await action({ kind: "smsSend", scope: scope! });
      setCooldown(60);
      setState("sent");
    } catch {
      setError("发送失败，请稍后重试");
      setState("failed");
    }
  }
  async function verify() {
    if (!/^\d{4,8}$/.test(code)) {
      setError("请输入 4–8 位数字验证码");
      smsInput.current?.focus();
      return;
    }
    setError("");
    setState("verifying");
    try {
      await action({ kind: "smsVerify", scope: scope!, code });
      setCode("");
      setState("success");
      resetService(client, service);
      void client.invalidateQueries({ queryKey: ["sessions"] });
    } catch {
      setError("验证未通过，请检查验证码或重新发送");
      setState("sent");
    }
  }
  return (
    <Modal
      title={
        scope
          ? scope === "timetable"
            ? "验证课表访问"
            : "验证树洞账号"
          : `连接${serviceNames[service]}`
      }
      description={
        scope
          ? "验证码将发送到你在学校绑定的手机。"
          : "使用「北京大学」App 扫码，在手机上确认登录。"
      }
      open
      onClose={onClose}
    >
      {methods}
      {state === "success" ? (
        <div className="auth-success">
          <CheckCircle2 size={40} />
          <h3>已连接</h3>
          <p>关闭后即可刷新相关内容。</p>
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        </div>
      ) : scope ? (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
          }}
        >
          <label htmlFor="sms">短信验证码</label>
          <div className="sms-row">
            <input
              id="sms"
              ref={smsInput}
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.nativeEvent.isComposing)
                  e.preventDefault();
              }}
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              aria-invalid={!!error}
              aria-describedby={error ? "auth-error" : undefined}
            />
            <Button
              disabled={cooldown > 0 || state === "loading"}
              onClick={() => void send()}
            >
              {cooldown ? `${cooldown} 秒后重发` : "发送验证码"}
            </Button>
          </div>
          <Button
            type="submit"
            variant="primary"
            disabled={state === "verifying"}
          >
            {state === "verifying" ? "正在验证…" : "验证"}
          </Button>
        </form>
      ) : (
        <div className="qr-area">
          {qr && state === "pending" ? (
            <>
              <img src={qr.qr} alt={`${serviceNames[service]}登录二维码`} />
              <p>等待扫码确认…</p>
            </>
          ) : (
            <>
              <div className="qr-placeholder">
                <RefreshCw
                  size={30}
                  className={state === "loading" ? "spin" : ""}
                />
              </div>
              {state === "expired" && <p>二维码已过期</p>}
              {state === "loading" ? (
                <p className="subtle">正在获取二维码…</p>
              ) : (
                <Button variant="primary" onClick={() => void begin()}>
                  {state === "expired" || state === "failed"
                    ? "重新获取二维码"
                    : "获取登录二维码"}
                </Button>
              )}
            </>
          )}
        </div>
      )}
      {error && (
        <p className="inline-error" id="auth-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
