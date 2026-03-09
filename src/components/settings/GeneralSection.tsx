"use client";

import { useState, useCallback, useEffect } from "react";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useTranslation } from "@/hooks/useTranslation";
import { SUPPORTED_LOCALES, type Locale } from "@/i18n";
import type { TranslationKey } from "@/i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { setNotificationEnabled } from "@/lib/notifications";

const DISPLAY_VERSION = "0.28.1-yd";

function VersionCard() {
  const { t } = useTranslation();

  return (
    <div className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium">{t('settings.codepilot')}</h2>
          <p className="text-xs text-muted-foreground">{t('settings.version', { version: DISPLAY_VERSION })}</p>
        </div>
      </div>
    </div>
  );
}

export function GeneralSection() {
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [showSkipPermWarning, setShowSkipPermWarning] = useState(false);
  const [skipPermSaving, setSkipPermSaving] = useState(false);
  const [thinkingMode, setThinkingMode] = useState<string>('adaptive');
  const [desktopNotifEnabled, setDesktopNotifEnabled] = useState(true);
  const [accountInfo, setAccountInfo] = useState<{ email?: string; organization?: string; subscriptionType?: string } | null>(null);
  const { t, locale, setLocale } = useTranslation();

  const fetchAppSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/app");
      if (res.ok) {
        const data = await res.json();
        const appSettings = data.settings || {};
        setSkipPermissions(appSettings.dangerously_skip_permissions === "true");
        if (appSettings.thinking_mode) {
          setThinkingMode(appSettings.thinking_mode);
        }
        // desktop_notification_enabled defaults to true when not set
        const notifVal = appSettings.desktop_notification_enabled;
        const notifEnabled = notifVal !== 'false';
        setDesktopNotifEnabled(notifEnabled);
        setNotificationEnabled(notifEnabled);
      }
    } catch {
      // ignore
    }
  }, []);

  const fetchAccountInfo = useCallback(async () => {
    try {
      const res = await fetch("/api/sdk/account");
      if (res.ok) {
        const data = await res.json();
        if (data.account) {
          setAccountInfo(data.account);
        }
      }
    } catch {
      // Account info not available
    }
  }, []);

  useEffect(() => {
    fetchAppSettings();
    fetchAccountInfo();
  }, [fetchAppSettings, fetchAccountInfo]);

  const saveThinkingMode = async (mode: string) => {
    setThinkingMode(mode);
    try {
      await fetch("/api/settings/app", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: { thinking_mode: mode },
        }),
      });
    } catch {
      // ignore
    }
  };

  const handleSkipPermToggle = (checked: boolean) => {
    if (checked) {
      setShowSkipPermWarning(true);
    } else {
      saveSkipPermissions(false);
    }
  };

  const saveSkipPermissions = async (enabled: boolean) => {
    setSkipPermSaving(true);
    try {
      const res = await fetch("/api/settings/app", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: { dangerously_skip_permissions: enabled ? "true" : "" },
        }),
      });
      if (res.ok) {
        setSkipPermissions(enabled);
      }
    } catch {
      // ignore
    } finally {
      setSkipPermSaving(false);
      setShowSkipPermWarning(false);
    }
  };

  const saveDesktopNotif = async (enabled: boolean) => {
    setDesktopNotifEnabled(enabled);
    setNotificationEnabled(enabled);
    try {
      await fetch("/api/settings/app", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: { desktop_notification_enabled: enabled ? "true" : "false" },
        }),
      });
    } catch {
      // ignore — state already updated optimistically
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <VersionCard />

      {/* Auto-approve toggle */}
      <div className={`rounded-lg border p-4 transition-shadow hover:shadow-sm ${skipPermissions ? "border-orange-500/50 bg-orange-500/5" : "border-border/50"}`}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium">{t('settings.autoApproveTitle')}</h2>
            <p className="text-xs text-muted-foreground">
              {t('settings.autoApproveDesc')}
            </p>
          </div>
          <Switch
            checked={skipPermissions}
            onCheckedChange={handleSkipPermToggle}
            disabled={skipPermSaving}
          />
        </div>
        {skipPermissions && (
          <div className="mt-3 flex items-center gap-2 rounded-md bg-orange-500/10 px-3 py-2 text-xs text-orange-600 dark:text-orange-400">
            <span className="h-2 w-2 shrink-0 rounded-full bg-orange-500" />
            {t('settings.autoApproveWarning')}
          </div>
        )}
      </div>

      {/* Language picker */}
      <div className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium">{t('settings.language')}</h2>
            <p className="text-xs text-muted-foreground">{t('settings.languageDesc')}</p>
          </div>
          <Select value={locale} onValueChange={(v) => setLocale(v as Locale)}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUPPORTED_LOCALES.map((l) => (
                <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Desktop notification toggle */}
      <div className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium">{t('settings.desktopNotification')}</h2>
            <p className="text-xs text-muted-foreground">{t('settings.desktopNotificationDesc')}</p>
          </div>
          <Switch
            checked={desktopNotifEnabled}
            onCheckedChange={saveDesktopNotif}
          />
        </div>
      </div>

      {/* Thinking mode */}
      <div className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium">{t('settings.thinkingMode' as TranslationKey)}</h2>
            <p className="text-xs text-muted-foreground">{t('settings.thinkingModeDesc' as TranslationKey)}</p>
          </div>
          <Select value={thinkingMode} onValueChange={saveThinkingMode}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="adaptive">{t('settings.thinkingAdaptive' as TranslationKey)}</SelectItem>
              <SelectItem value="enabled">{t('settings.thinkingEnabled' as TranslationKey)}</SelectItem>
              <SelectItem value="disabled">{t('settings.thinkingDisabled' as TranslationKey)}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Account info */}
      {accountInfo && (
        <div className="rounded-lg border border-border/50 p-4 transition-shadow hover:shadow-sm">
          <h2 className="text-sm font-medium mb-2">{t('settings.accountInfo' as TranslationKey)}</h2>
          <div className="space-y-1">
            {accountInfo.email && (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{t('settings.email' as TranslationKey)}:</span> {accountInfo.email}
              </p>
            )}
            {accountInfo.organization && (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{t('settings.organization' as TranslationKey)}:</span> {accountInfo.organization}
              </p>
            )}
            {accountInfo.subscriptionType && (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{t('settings.subscription' as TranslationKey)}:</span> {accountInfo.subscriptionType}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Skip-permissions warning dialog */}
      <AlertDialog open={showSkipPermWarning} onOpenChange={setShowSkipPermWarning}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.autoApproveDialogTitle')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  {t('settings.autoApproveDialogDesc')}
                </p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>{t('settings.autoApproveShellCommands')}</li>
                  <li>{t('settings.autoApproveFileOps')}</li>
                  <li>{t('settings.autoApproveNetwork')}</li>
                </ul>
                <p className="font-medium text-orange-600 dark:text-orange-400">
                  {t('settings.autoApproveTrustWarning')}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('settings.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => saveSkipPermissions(true)}
              className="bg-orange-600 hover:bg-orange-700 text-white"
            >
              {t('settings.enableAutoApprove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
