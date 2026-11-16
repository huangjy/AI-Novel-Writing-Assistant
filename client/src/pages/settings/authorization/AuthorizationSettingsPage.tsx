import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpRight, CheckCircle2, Copy, Github, LoaderCircle, LogIn, LogOut, RefreshCw, ShieldCheck, X } from "lucide-react";
import { Link } from "react-router-dom";
import {
  cancelAuthorizationSession, getAuthorizationSession, logoutCopilot, refreshCopilotModels, startCopilotLogin,
} from "@/api/authorization";
import { queryKeys } from "@/api/queryKeys";
import { Button } from "@/components/ui/button";
import { SettingsShell } from "../components/SettingsShell";
import { APP_RUNTIME } from "@/lib/constants";
import { openCopilotLoginInBrowser } from "@/lib/desktop";
import { ACCOUNT_STATE_LABELS } from "./authorizationPolicy";
import { refreshAuthorizationProjections, useCopilotAccount } from "./useCopilotAccount";

export default function AuthorizationSettingsPage() {
  const client = useQueryClient();
  const accountQuery = useCopilotAccount();
  const account = accountQuery.data?.data;
  const [lastSessionId, setLastSessionId] = useState("");
  const [replaceAccount, setReplaceAccount] = useState(false);
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now);
  const sessionId = lastSessionId || account?.activeSession?.id || "";
  const sessionQuery = useQuery({
    queryKey: queryKeys.settings.authorizationSession(sessionId),
    queryFn: () => getAuthorizationSession(sessionId), enabled: Boolean(sessionId), retry: false,
    refetchInterval: query => query.state.data?.data?.state === "pending"
      ? Math.max(1000, query.state.data.data.pollIntervalMs) : false,
  });
  const session = sessionQuery.data?.data ?? account?.activeSession;
  const pending = session?.state === "pending";
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pending]);
  useEffect(() => {
    if (session?.state && session.state !== "pending") void refreshAuthorizationProjections(client);
  }, [client, session?.state, session?.id]);

  const login = useMutation({
    mutationFn: () => startCopilotLogin(replaceAccount),
    onSuccess: async response => {
      if (response.data) setLastSessionId(response.data.id);
      setNotice("");
      await refreshAuthorizationProjections(client);
    },
  });
  const logout = useMutation({
    mutationFn: () => logoutCopilot(account?.credentialRevision ?? 0),
    onSuccess: async () => {
      setLastSessionId(""); setReplaceAccount(false); setNotice("已退出 GitHub Copilot，关联厂商配置和创作结果均保留。");
      await refreshAuthorizationProjections(client);
    },
  });
  const cancel = useMutation({
    mutationFn: () => cancelAuthorizationSession(sessionId),
    onSuccess: async response => {
      client.setQueryData(queryKeys.settings.authorizationSession(sessionId), response);
      await refreshAuthorizationProjections(client);
    },
  });
  const refresh = useMutation({
    mutationFn: refreshCopilotModels,
    onSuccess: async () => { setNotice("模型目录已刷新。"); await refreshAuthorizationProjections(client); },
  });
  const error = accountQuery.error ?? sessionQuery.error ?? login.error ?? logout.error ?? cancel.error ?? refresh.error;
  const busy = login.isPending || logout.isPending || cancel.isPending || refresh.isPending;
  const authorized = account?.state === "authorized";
  const seconds = session ? Math.max(0, Math.ceil((session.expiresAt - now) / 1000)) : 0;
  const startLogin = () => {
    if (replaceAccount && !window.confirm(`将 ${account?.bindings.length ?? 0} 个关联厂商接到另一个 GitHub 账户？`)) return;
    login.mutate();
  };

  return (
    <SettingsShell title="授权中心" description="管理用于创作的订阅账户与关联厂商。">
      <Button asChild variant="ghost" size="sm"><Link to="/settings/models"><ArrowLeft className="h-4 w-4" />模型与厂商</Link></Button>
      <section aria-labelledby="copilot-heading" className="space-y-5 py-2">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Github className="h-7 w-7 shrink-0" />
            <div className="min-w-0">
              <h2 id="copilot-heading" className="text-lg font-semibold">GitHub Copilot</h2>
              <p className="break-all text-sm text-muted-foreground">{account?.login || "未关联 GitHub 账户"}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm" role="status">
            {authorized ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <ShieldCheck className="h-4 w-4 text-muted-foreground" />}
            {accountQuery.isPending ? "读取中..." : account ? ACCOUNT_STATE_LABELS[account.state] : "状态不可用"}
          </div>
        </div>

        {pending && session ? (
          <div className="space-y-4 rounded-md bg-muted/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="inline-flex items-center gap-2"><LoaderCircle className="h-4 w-4 animate-spin" />
                {session.phase === "saving" ? "正在保存授权并读取模型" : session.phase === "validating" ? "正在确认 Copilot 订阅" : "等待 GitHub 授权"}
              </span>
              {session.phase === "authorizing" ? <span className="text-muted-foreground">{seconds > 0 ? `${seconds} 秒内有效` : "等待确认登录结果"}</span> : null}
            </div>
            {session.userCode && session.phase === "authorizing" ? <div className="flex flex-wrap items-center gap-3">
              <code className="select-all break-all text-xl font-semibold">{session.userCode}</code>
              <Button size="icon" variant="ghost" title="复制登录码" aria-label="复制登录码" onClick={async () => {
                try { await navigator.clipboard.writeText(session.userCode ?? ""); setNotice("登录码已复制。"); }
                catch { setNotice("无法访问剪贴板，请选中登录码复制。"); }
              }}><Copy className="h-4 w-4" /></Button>
            </div> : null}
            <div className="flex flex-wrap gap-2">
              {session.phase === "authorizing" ? <Button asChild><a href={session.verificationUri} target="_blank" rel="noopener noreferrer"
                onClick={async event => {
                  if (APP_RUNTIME !== "desktop") return;
                  event.preventDefault();
                  try {
                    if (await openCopilotLoginInBrowser()) return;
                  } catch { /* The verification URL remains usable in a separate browser. */ }
                  setNotice("无法启动系统浏览器，请访问 github.com/login/device 并输入登录码。");
                }}>打开 GitHub<ArrowUpRight className="h-4 w-4" /></a></Button> : null}
              <Button variant="ghost" disabled={busy || session.phase === "saving"} onClick={() => cancel.mutate()}><X className="h-4 w-4" />取消登录</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || accountQuery.isPending || accountQuery.isError} onClick={startLogin}>
              {login.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
              {login.isPending ? "获取登录码..." : authorized || account?.state === "reauthorization_required" ? "重新授权" : "登录 GitHub"}
            </Button>
            {account && account.state !== "signed_out" ? (
              <Button variant="secondary" disabled={busy} onClick={() => {
                if (window.confirm(`退出 GitHub Copilot？${account.bindings.length} 个关联厂商需重新授权，配置和创作结果会保留。`)) logout.mutate();
              }}><LogOut className="h-4 w-4" />退出账户</Button>
            ) : null}
          </div>
        )}

        {account?.state === "signed_out" && account.login && !pending ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={replaceAccount} onChange={event => setReplaceAccount(event.target.checked)} />
            使用其他 GitHub 账户，并重新关联全部厂商
          </label>
        ) : null}
        {(error || session?.error) ? <p role="alert" className="text-sm text-destructive">{error instanceof Error ? error.message : session?.error}</p> : null}
        {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
        {accountQuery.isError ? <Button variant="ghost" onClick={() => void accountQuery.refetch()}><RefreshCw className="h-4 w-4" />重试读取</Button> : null}

        <div className="space-y-3 border-t pt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">关联厂商 · {account?.bindings.length ?? 0}</h3>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" size="sm" disabled={!authorized || busy || pending} onClick={() => refresh.mutate()}>
                <RefreshCw className={`h-4 w-4 ${refresh.isPending ? "animate-spin" : ""}`} />刷新模型
              </Button>
              <Button asChild variant="ghost" size="sm"><Link to="/settings/models">管理厂商<ArrowUpRight className="h-4 w-4" /></Link></Button>
            </div>
          </div>
          {account?.catalogState !== "ready" && authorized && !pending ? (
            <p className="text-sm text-amber-700 dark:text-amber-400">模型目录待刷新。</p>
          ) : null}
          {account?.bindings.length ? (
            <ul className="divide-y">
              {account.bindings.map(binding => (
                <li key={binding.provider} className="flex min-w-0 items-center justify-between gap-3 py-3 text-sm">
                  <span className="break-all">{binding.displayName || binding.provider}</span>
                  <Link className="shrink-0 text-primary hover:underline" to={`/settings/models?provider=${encodeURIComponent(binding.provider)}`}>管理连接</Link>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted-foreground">尚未关联模型厂商。</p>}
        </div>
      </section>
    </SettingsShell>
  );
}
