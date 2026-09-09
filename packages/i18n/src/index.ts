import i18next from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import { type Locale, type MessageKey, resources } from "./resources";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    returnNull: false;
    resources: { translation: Record<MessageKey, string> };
  }
}

const STORAGE_KEY = "clawler.locale";
export const supportedLocales: readonly Locale[] = ["zh-CN", "en-US"];

export function resolveLocale(value: string | null | undefined): Locale {
  if (value?.toLowerCase().startsWith("en")) return "en-US";
  return "zh-CN";
}

export async function initializeI18n(): Promise<void> {
  let locale: Locale = "zh-CN";
  try {
    locale = resolveLocale(localStorage.getItem(STORAGE_KEY));
  } catch {
    /* Storage can be disabled. */
  }
  await i18next.use(initReactI18next).init({
    resources,
    lng: locale,
    fallbackLng: "zh-CN",
    supportedLngs: [...supportedLocales],
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  document.documentElement.lang = locale;
  document.title = i18next.t("appName");
}

export function useI18n() {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale(i18n.resolvedLanguage);

  async function setLocale(next: Locale): Promise<void> {
    await i18n.changeLanguage(next);
    document.documentElement.lang = next;
    document.title = i18n.t("appName");
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* Keep in-memory preference. */
    }
  }

  function translate(key: MessageKey, values?: Record<string, string | number>): string {
    if (!values) return t(key);
    return t(key, { replace: values });
  }

  function formatDate(value: string): string {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(value),
    );
  }

  function formatNumber(value: number): string {
    return new Intl.NumberFormat(locale).format(value);
  }

  return { t: translate, locale, setLocale, formatDate, formatNumber };
}

export type { Locale, MessageKey } from "./resources";
