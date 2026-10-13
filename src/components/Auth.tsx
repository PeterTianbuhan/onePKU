import { useEffect, useState, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, RefreshCw } from "lucide-react";
import {
  action,
  serviceNames,
  resetService,
  useResource,
  type Service,
} from "../lib/api";
import { Button, Modal } from "./ui";
export default function Auth({
  service,
  scope,
  onClose,
}: {
  service: Service;
  scope?: "treehole" | "timetable";
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [qr, setQr] = useState<{ id: string; qr: string }>();
  const [state, setState] = useState("idle");
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const [cooldown, setCooldown] = useState(0);
  // 与安卓端一致：账号密码一次提交，四个服务依次换回会话，免去逐页扫码。
  const [mode, setMode] = useState<"qr" | "password">("qr");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [everywhere, setEverywhere] = useState(true);
  const [partial, setPartial] = useState<string[]>([]);
  // 与安卓端一样：账号密码可以存进系统加密存储，会话过期后自动换票。
  const [remember, setRemember] = useState(true);
  const stored = useResource<{ stored: boolean; username: string }>({
    kind: "credentials",
  });
  const active = useRef(true);
  const smsInput = useRef<HTMLInputElement>(null);
  const currentId = useRef<string | undefined>(undefined);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (currentId.current)
        void action({ kind: "authCancel", id: currentId.current });
    };
  }, []);
  // 扫码登录打开即取二维码，不用先点一次按钮；短信验证不自动发送。
  useEffect(() => {
    if (scope || mode === "password") return;
    void begin();
    // begin 只依赖 service，而 service 变化会重新挂载组件。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, mode]);
  useEffect(() => {
    if (!cooldown) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);
  async function begin() {
    setState("loading");
    setError("");
    if (currentId.current)
      void action({ kind: "authCancel", id: currentId.current });
    try {
      const q = await action<{ id: string; qr: string }>({
        kind: "authBegin",
        service,
      });
      if (!active.current) {
        void action({ kind: "authCancel", id: q.id });
        return;
      }
      currentId.current = q.id;
      setQr(q);
      setState("pending");
    } catch (e) {
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
  async function submit() {
    setError("");
    setPartial([]);
    setState("loading");
    try {
      const result = await action<{
        done: string[];
        failed?: { message: string }[];
        remembered?: boolean;
      }>({
        kind: "authPassword",
        username: user,
        password,
        otp: otp.trim() || null,
        // 门户只是用来认院系的，不参与「一次连全部数据服务」。
        services: everywhere && service !== "portal" ? [] : [service],
        remember,
      });
      for (const name of result.done) resetService(client, name as Service);
      setPartial([
        ...(result.failed ?? []).map((f) => f.message),
        ...(remember && result.remembered === false
          ? ["系统钥匙串不可用，这次没有记住账号"]
          : []),
      ]);
      setState("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "登录失败，请重试");
      setState("idle");
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
          : mode === "password"
            ? "账号与密码只用于向学校统一身份认证换票，不写入本机文件。"
            : "使用「北京大学」App 扫码，在手机上确认登录。"
      }
      open
      onClose={onClose}
    >
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
      ) : mode === "password" ? (
        <form
          className="auth-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="iaaa-user">校园账号</label>
          <input
            id="iaaa-user"
            autoComplete="username"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            aria-invalid={!!error}
            aria-describedby={error ? "auth-error" : undefined}
          />
          <label htmlFor="iaaa-pass">密码</label>
          <input
            id="iaaa-pass"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <label htmlFor="iaaa-otp">动态口令（未开启可留空）</label>
          <input
            id="iaaa-otp"
            type="password"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={otp}
            onChange={(e) => setOtp(e.target.value)}
          />
          {service !== "portal" && (
            <label className="auth-check">
              <input
                type="checkbox"
                checked={everywhere}
                onChange={(e) => setEverywhere(e.target.checked)}
              />
              一次连接全部服务（教学网、树洞、校园卡、北大空间）
            </label>
          )}
          <label className="auth-check">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            记住账号密码（存在系统钥匙串里，过期自动重连）
          </label>
          {stored.data?.data?.stored && (
            <p className="subtle">
              已记住 {stored.data.data.username}；账号与密码留空就直接用它登录。
            </p>
          )}
          <Button
            type="submit"
            variant="primary"
            disabled={state === "loading"}
          >
            {state === "loading" ? "正在登录…" : "登录"}
          </Button>
          {partial.length > 0 && (
            <p className="inline-error">
              已连上部分服务，其余未成功：{partial.join("；")}
            </p>
          )}
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
      {!scope && state !== "success" && (
        <button
          className="text-button auth-switch"
          onClick={() => {
            setError("");
            setMode(mode === "qr" ? "password" : "qr");
          }}
        >
          {mode === "qr" ? "改用账号密码登录" : "改用北京大学 App 扫码"}
        </button>
      )}
    </Modal>
  );
}
