"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Loading02Icon,
  CheckmarkCircle02Icon,
  Alert02Icon,
  Copy01Icon,
  Tick01Icon,
} from "@hugeicons/core-free-icons";
import { useTranslation } from "@/hooks/useTranslation";

interface PopoBridgeSettings {
  bridge_popo_enabled: string;
  bridge_popo_app_key: string;
  bridge_popo_app_secret: string;
  bridge_popo_robot_email: string;
  bridge_popo_webhook_token: string;
  bridge_popo_aes_key: string;
  bridge_popo_allowed_users: string;
  bridge_popo_notify_email: string;
}

const DEFAULT_SETTINGS: PopoBridgeSettings = {
  bridge_popo_enabled: "false",
  bridge_popo_app_key: "",
  bridge_popo_app_secret: "",
  bridge_popo_robot_email: "",
  bridge_popo_webhook_token: "",
  bridge_popo_aes_key: "",
  bridge_popo_allowed_users: "",
  bridge_popo_notify_email: "",
};

interface TunnelInfo {
  tunnel: { state: string; url: string | null; error: string | null };
  internalIp: string | null;
  internalWebhookUrl: string | null;
  tunnelWebhookUrl: string | null;
}

export function PopoBridgeSection() {
  const [appKey, setAppKey] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [robotEmail, setRobotEmail] = useState("");
  const [webhookToken, setWebhookToken] = useState("");
  const [aesKey, setAesKey] = useState("");
  const [allowedUsers, setAllowedUsers] = useState("");
  const [notifyEmail, setNotifyEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [tunnelInfo, setTunnelInfo] = useState<TunnelInfo | null>(null);
  const [tunnelLoading, setTunnelLoading] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { t } = useTranslation();

  // ── Fetch settings ───────────────────────────────────────────

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/popo");
      if (res.ok) {
        const data = await res.json();
        const s = { ...DEFAULT_SETTINGS, ...data.settings };
        setAppKey(s.bridge_popo_app_key);
        setAppSecret(s.bridge_popo_app_secret);
        setRobotEmail(s.bridge_popo_robot_email);
        setWebhookToken(s.bridge_popo_webhook_token);
        setAesKey(s.bridge_popo_aes_key);
        setAllowedUsers(s.bridge_popo_allowed_users);
        setNotifyEmail(s.bridge_popo_notify_email);
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchTunnelInfo = useCallback(async (): Promise<TunnelInfo | null> => {
    try {
      const res = await fetch("/api/settings/popo/tunnel");
      if (res.ok) {
        const data = await res.json() as TunnelInfo;
        setTunnelInfo(data);
        return data;
      }
    } catch {
      // ignore
    }
    return null;
  }, []);

  useEffect(() => {
    fetchSettings();
    fetchTunnelInfo();
  }, [fetchSettings, fetchTunnelInfo]);

  // ── Tunnel polling while state = 'starting' ──────────────────

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (tunnelInfo?.tunnel.state === "starting") {
      if (!pollingRef.current) {
        pollingRef.current = setInterval(async () => {
          const info = await fetchTunnelInfo();
          if (info?.tunnel.state !== "starting") {
            stopPolling();
          }
        }, 2000);
      }
    } else {
      stopPolling();
    }
    return stopPolling;
  }, [tunnelInfo?.tunnel.state, fetchTunnelInfo, stopPolling]);

  // ── Save credentials ─────────────────────────────────────────

  const handleSaveCredentials = async () => {
    setSaving(true);
    try {
      const updates: Partial<PopoBridgeSettings> = {
        bridge_popo_app_key: appKey,
        bridge_popo_robot_email: robotEmail,
        bridge_popo_webhook_token: webhookToken,
      };
      if (appSecret && !appSecret.startsWith("***")) {
        updates.bridge_popo_app_secret = appSecret;
      }
      if (aesKey && !aesKey.startsWith("***")) {
        updates.bridge_popo_aes_key = aesKey;
      }
      await fetch("/api/settings/popo", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: updates }),
      });
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  const handleSaveAllowedUsers = async () => {
    setSaving(true);
    try {
      await fetch("/api/settings/popo", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: { bridge_popo_allowed_users: allowedUsers },
        }),
      });
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  const handleSaveNotifyEmail = async () => {
    setSaving(true);
    try {
      await fetch("/api/settings/popo", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: { bridge_popo_notify_email: notifyEmail },
        }),
      });
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  // ── Verify connection ────────────────────────────────────────

  const handleVerify = async () => {
    if (!appKey) {
      setVerifyResult({
        ok: false,
        message: t("popo.enterCredentialsFirst"),
      });
      return;
    }
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await fetch("/api/settings/popo/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_key: appKey, app_secret: appSecret }),
      });
      const data = await res.json();
      if (data.verified) {
        setVerifyResult({ ok: true, message: t("popo.verified") });
      } else {
        setVerifyResult({
          ok: false,
          message: data.error || t("popo.verifyFailed"),
        });
      }
    } catch {
      setVerifyResult({ ok: false, message: t("popo.verifyFailed") });
    } finally {
      setVerifying(false);
    }
  };

  // ── Tunnel controls ──────────────────────────────────────────

  const handleStartTunnel = async () => {
    setTunnelLoading(true);
    try {
      const res = await fetch("/api/settings/popo/tunnel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      if (res.ok) {
        const data = await res.json() as TunnelInfo;
        setTunnelInfo(data);
      }
    } catch {
      // ignore
    } finally {
      setTunnelLoading(false);
    }
  };

  const handleStopTunnel = async () => {
    setTunnelLoading(true);
    try {
      const res = await fetch("/api/settings/popo/tunnel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });
      if (res.ok) {
        await fetchTunnelInfo();
      }
    } catch {
      // ignore
    } finally {
      setTunnelLoading(false);
    }
  };

  // ── Copy to clipboard ────────────────────────────────────────

  const handleCopy = async (url: string, key: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      // ignore
    }
  };

  const tunnelState = tunnelInfo?.tunnel.state ?? "idle";

  return (
    <div className="max-w-3xl space-y-6">
      {/* App Credentials */}
      <div className="rounded-lg border border-border/50 p-4 space-y-4 transition-shadow hover:shadow-sm">
        <div>
          <h2 className="text-sm font-medium">{t("popo.credentials")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("popo.credentialsDesc")}
          </p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("popo.appKey")}
            </label>
            <Input
              value={appKey}
              onChange={(e) => setAppKey(e.target.value)}
              placeholder="zXxxxxxxxxxxxxxxxxxxx"
              className="font-mono text-sm"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("popo.appSecret")}
            </label>
            <Input
              type="password"
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
              placeholder="••••••••••••••••"
              className="font-mono text-sm"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("popo.robotEmail")}
            </label>
            <Input
              value={robotEmail}
              onChange={(e) => setRobotEmail(e.target.value)}
              placeholder="robot@corp.com"
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground mt-1">
              {t("popo.robotEmailDesc")}
            </p>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("popo.webhookToken")}
            </label>
            <Input
              type="password"
              value={webhookToken}
              onChange={(e) => setWebhookToken(e.target.value)}
              placeholder="••••••••••••••••"
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground mt-1">
              {t("popo.webhookTokenDesc")}
            </p>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("popo.aesKey")}
            </label>
            <Input
              type="password"
              value={aesKey}
              onChange={(e) => setAesKey(e.target.value)}
              placeholder="••••••••••••••••••••••••••••••••••••••••••"
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground mt-1">
              {t("popo.aesKeyDesc")}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={handleSaveCredentials} disabled={saving}>
            {saving ? t("common.loading") : t("common.save")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleVerify}
            disabled={verifying || !appKey}
          >
            {verifying ? (
              <HugeiconsIcon
                icon={Loading02Icon}
                className="h-3.5 w-3.5 animate-spin mr-1.5"
              />
            ) : null}
            {t("popo.verify")}
          </Button>
        </div>

        {verifyResult && (
          <div
            className={`flex items-center gap-2 rounded-md px-3 py-2 text-xs ${
              verifyResult.ok
                ? "bg-green-500/10 text-green-600 dark:text-green-400"
                : "bg-red-500/10 text-red-600 dark:text-red-400"
            }`}
          >
            <HugeiconsIcon
              icon={verifyResult.ok ? CheckmarkCircle02Icon : Alert02Icon}
              className="h-4 w-4 shrink-0"
            />
            {verifyResult.message}
          </div>
        )}
      </div>

      {/* Webhook URL */}
      <div className="rounded-lg border border-border/50 p-4 space-y-4 transition-shadow hover:shadow-sm">
        <div>
          <h2 className="text-sm font-medium">{t("popo.webhookUrl")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("popo.webhookUrlDesc")}
          </p>
        </div>

        {/* Internal IP */}
        <div className="space-y-2">
          <p className="text-xs font-medium">
            📡 {t("popo.internalUrl")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("popo.internalUrlDesc")}
          </p>
          {tunnelInfo?.internalWebhookUrl ? (
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded bg-muted px-2 py-1.5 text-xs font-mono truncate">
                {tunnelInfo.internalWebhookUrl}
              </code>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() =>
                  handleCopy(tunnelInfo.internalWebhookUrl!, "internal")
                }
              >
                <HugeiconsIcon
                  icon={copiedKey === "internal" ? Tick01Icon : Copy01Icon}
                  className="h-3.5 w-3.5"
                />
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic">
              {t("popo.internalUrlUnavailable")}
            </p>
          )}
        </div>

        <div className="border-t border-border/30" />

        {/* Cloudflare Tunnel */}
        <div className="space-y-2">
          <p className="text-xs font-medium">
            🌐 {t("popo.tunnelSection")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("popo.tunnelDesc")}
          </p>

          <div className="flex items-center gap-2">
            {(tunnelState === "idle" ||
              tunnelState === "stopped" ||
              tunnelState === "error") && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleStartTunnel}
                disabled={tunnelLoading}
              >
                {tunnelLoading ? (
                  <HugeiconsIcon
                    icon={Loading02Icon}
                    className="h-3.5 w-3.5 animate-spin mr-1.5"
                  />
                ) : null}
                {t("popo.startTunnel")}
              </Button>
            )}

            {tunnelState === "starting" && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <HugeiconsIcon
                  icon={Loading02Icon}
                  className="h-3.5 w-3.5 animate-spin"
                />
                {t("popo.tunnelStarting")}
              </div>
            )}

            {tunnelState === "running" && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleStopTunnel}
                disabled={tunnelLoading}
              >
                {tunnelLoading ? (
                  <HugeiconsIcon
                    icon={Loading02Icon}
                    className="h-3.5 w-3.5 animate-spin mr-1.5"
                  />
                ) : null}
                {t("popo.stopTunnel")}
              </Button>
            )}
          </div>

          {tunnelState === "running" && tunnelInfo?.tunnelWebhookUrl && (
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded bg-muted px-2 py-1.5 text-xs font-mono truncate">
                {tunnelInfo.tunnelWebhookUrl}
              </code>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() =>
                  handleCopy(tunnelInfo.tunnelWebhookUrl!, "tunnel")
                }
              >
                <HugeiconsIcon
                  icon={copiedKey === "tunnel" ? Tick01Icon : Copy01Icon}
                  className="h-3.5 w-3.5"
                />
              </Button>
            </div>
          )}

          {tunnelState === "error" && tunnelInfo?.tunnel.error && (
            <p className="text-xs text-red-500 dark:text-red-400">
              {tunnelInfo.tunnel.error}
            </p>
          )}
        </div>
      </div>

      {/* Allowed Users */}
      <div className="rounded-lg border border-border/50 p-4 space-y-4 transition-shadow hover:shadow-sm">
        <div>
          <h2 className="text-sm font-medium">{t("popo.allowedUsers")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("popo.allowedUsersDesc")}
          </p>
        </div>

        <div>
          <Input
            value={allowedUsers}
            onChange={(e) => setAllowedUsers(e.target.value)}
            placeholder="user1@corp.com, user2@corp.com"
            className="font-mono text-sm"
          />
        </div>

        <Button size="sm" onClick={handleSaveAllowedUsers} disabled={saving}>
          {saving ? t("common.loading") : t("common.save")}
        </Button>
      </div>

      {/* Notification Email */}
      <div className="rounded-lg border border-border/50 p-4 space-y-4 transition-shadow hover:shadow-sm">
        <div>
          <h2 className="text-sm font-medium">{t("popo.notifyEmail")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("popo.notifyEmailDesc")}
          </p>
        </div>

        <div>
          <Input
            value={notifyEmail}
            onChange={(e) => setNotifyEmail(e.target.value)}
            placeholder="admin@corp.com"
            className="font-mono text-sm"
          />
        </div>

        <Button size="sm" onClick={handleSaveNotifyEmail} disabled={saving}>
          {saving ? t("common.loading") : t("common.save")}
        </Button>
      </div>

      {/* Setup Guide */}
      <div className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm">
        <h2 className="text-sm font-medium mb-2">{t("popo.setupGuide")}</h2>
        <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal pl-4">
          <li>{t("popo.step1")}</li>
          <li>{t("popo.step2")}</li>
          <li>{t("popo.step3")}</li>
          <li>{t("popo.step4")}</li>
          <li>{t("popo.step5")}</li>
        </ol>
      </div>
    </div>
  );
}
