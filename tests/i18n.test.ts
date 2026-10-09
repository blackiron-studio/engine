// Localization: lookups with fallbacks, placeholders, plurals, selects, Intl numbers, locale
// switches that notify watchers, and right-to-left detection.

import { describe, expect, test } from "bun:test";
import { I18n, createI18n, t } from "../src/i18n/index.ts";

const messages = {
  en: {
    hello: "Hello, {name}!",
    coins: "{count, plural, =0 {No coins} one {# coin} other {# coins}}",
    who: "{kind, select, warden {A warden} other {A stranger}} arrives",
    total: "Score {score, number}",
    only: "English only",
  },
  fr: {
    hello: "Bonjour, {name} !",
    coins: "{count, plural, one {# pièce} other {# pièces}}",
  },
  "fr-CA": { hello: "Allô, {name}!" },
  ar: { hello: "مرحبا {name}" },
};

describe("I18n", () => {
  test("looks up the locale, then its base, then the fallback, then the key", () => {
    const i = new I18n({ messages, locale: "fr-CA", fallback: "en" });
    expect(i.t("hello", { name: "Ashe" })).toBe("Allô, Ashe!");
    expect(i.t("coins", { count: 2 })).toBe("2 pièces");
    expect(i.t("only")).toBe("English only");
    expect(i.t("missing")).toBe("missing");
    expect(i.has("only")).toBe(true);
    expect(i.locales).toEqual(["en", "fr", "fr-CA", "ar"]);
  });

  test("plurals, selects and numbers follow the locale", () => {
    const i = new I18n({ messages, locale: "en" });
    expect(i.t("coins", { count: 0 })).toBe("No coins");
    expect(i.t("coins", { count: 1 })).toBe("1 coin");
    expect(i.t("coins", { count: 1234 })).toBe("1,234 coins");
    expect(i.t("who", { kind: "warden" })).toBe("A warden arrives");
    expect(i.t("who", { kind: "cat" })).toBe("A stranger arrives");
    expect(i.t("total", { score: 9876543 })).toBe("Score 9,876,543");
    i.locale = "fr";
    expect(i.t("coins", { count: 1234 })).toBe("1 234 pièces".replace(" ", i.number(1234).charAt(1)));
    expect(i.rtl).toBe(false);
    i.locale = "ar";
    expect(i.rtl).toBe(true);
  });

  test("watchers run at once and on every change; the shared instance follows createI18n", () => {
    const i = createI18n({ messages, locale: "en" });
    const seen: string[] = [];
    const stop = i.watch((l) => seen.push(l));
    i.locale = "fr";
    i.add("fr", { only: "Français seulement" });
    expect(seen).toEqual(["en", "fr", "fr"]);
    expect(t("only")).toBe("Français seulement");
    stop();
    i.locale = "en";
    expect(seen.length).toBe(3);
    expect(I18n.preferred(["fr", "en"], "en")).toMatch(/^(fr|en)$/);
    expect(I18n.preferred(["de"], "en")).toBe("de");
  });
});
