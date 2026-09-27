// Help / 使い方 UI v2・Playwrightテスト（新規）
//
// 目的：ヘッダーの「📖 使い方」（旧「？ ヘルプ」）ボタンの開閉、および
// Help内の4層構造（🌱 はじめての方へ／✨ やりたいことから探す／🔍 機能から探す／
// ⌨️ ショートカット）の初期開閉状態・個別開閉を確認する。
//
// CollapsibleGroupの見出しボタンはアクセシブルネームに開閉矢印（▶／▼）を含むため、
// 完全一致ではなく部分一致（正規表現）でlocatorを取得する。

import { test, expect } from "@playwright/test";

async function openFreshApp(page) {
  await page.addInitScript(() => {
    try {
      window.localStorage.clear();
    } catch (e) {
      // ignore
    }
  });
  await page.goto("/");
}

// ボタンのアクセシブルネームはaria-label「使い方を表示／非表示」（旧「ヘルプを表示／非表示」）。
// 可視テキスト「📖 使い方」はaria-labelとは別に表示されるため、locatorはaria-label側で取得する。
const helpToggleButton = (page) => page.getByRole("button", { name: "使い方を表示／非表示" });

// Help本体の<section>コンテナ。「機能から探す」内の項目名（出演者・照明・再生・表示・出力等）は
// アプリ本体の実際のUI（ヘッダーの「出力」ボタン、再生ボタンのaria-label「再生」等）と
// 同じ文字列を含むため、Help専用の見出し（「ダンス舞台シミュレーター」h2）を持つ<section>に
// スコープすることで、本体UIとの取り違えを避ける。
const helpSection = (page) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: "ダンス舞台シミュレーター", level: 2 }) });

test.describe("Help / 使い方 UI v2", () => {
  test("「📖 使い方」ボタンでHelpパネルが開閉できる", async ({ page }) => {
    await openFreshApp(page);

    await expect(helpToggleButton(page)).toBeVisible();
    await expect(helpToggleButton(page)).toHaveText("📖 使い方");
    await expect(page.getByRole("heading", { name: "ダンス舞台シミュレーター", level: 2 })).toHaveCount(0);

    await helpToggleButton(page).click();
    await expect(page.getByRole("heading", { name: "ダンス舞台シミュレーター", level: 2 })).toBeVisible();

    await helpToggleButton(page).click();
    await expect(page.getByRole("heading", { name: "ダンス舞台シミュレーター", level: 2 })).toHaveCount(0);
  });

  test("Help冒頭の説明文が新しい内容に置き換わっている（旧説明文は残っていない）", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    await expect(page.getByText("構成・移動・音楽・照明を、ひとつの時間軸で設計するツール。")).toBeVisible();
    await expect(page.getByText("移動経路、音楽との同期、照明キューまで設定できます。", { exact: false })).toBeVisible();

    // 旧説明文（「出演者の立ち位置だけでなく、構成間の立ち位置…」に相当する文章）は残っていない。
    await expect(page.getByText("出演者の立ち位置だけでなく、構成間の立ち位置", { exact: false })).toHaveCount(0);
  });

  test("「🌱 はじめての方へ」は初期状態でCLOSEDであり、開くと新しい冒頭文・既存手順1〜7が表示される", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const gettingStartedHeader = page.getByRole("button", { name: /はじめての方へ/ });
    await expect(gettingStartedHeader).toBeVisible();
    await expect(gettingStartedHeader).toHaveAttribute("aria-expanded", "false");

    // 初期状態では本文（新しい冒頭文・手順）は展開されていないため見えない。
    await expect(
      page.getByText("まずは出演者を置いて、2つの構成を作り、動かしてみるのがおすすめです。", { exact: false })
    ).toHaveCount(0);

    await gettingStartedHeader.click();
    await expect(gettingStartedHeader).toHaveAttribute("aria-expanded", "true");

    // 新しい冒頭文（Help v2.2で整理）。
    await expect(
      page.getByText("まずは出演者を置いて、2つの構成を作り、動かしてみるのがおすすめです。", { exact: false })
    ).toBeVisible();
    await expect(page.getByText("高台・階段や音楽・照明などの機能は、必要になったときに追加できます。", { exact: false })).toBeVisible();

    // 削除対象の旧冒頭文は表示されない。
    await expect(
      page.getByText("このツールでは、ダンスの立ち位置・構成間の移動・音楽・照明をまとめて確認できます。")
    ).toHaveCount(0);

    // 既存の手順1〜7は変更せず維持されている。
    await expect(page.getByText("1. ステージの大きさを決める")).toBeVisible();
    await expect(page.getByText("7. 確認・共有する")).toBeVisible();
  });

  test("「✨ やりたいことから探す」は初期状態でOPENであり、中の各項目は初期状態でCLOSED", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const wantToDoHeader = page.getByRole("button", { name: /やりたいことから探す/ });
    await expect(wantToDoHeader).toBeVisible();
    await expect(wantToDoHeader).toHaveAttribute("aria-expanded", "true");

    const itemHeader = page.getByRole("button", { name: /高台・階段を作りたい/ });
    await expect(itemHeader).toBeVisible();
    await expect(itemHeader).toHaveAttribute("aria-expanded", "false");

    // 初期状態では本文は展開されていないため見えない。
    await expect(page.getByText("高台へ上がる階段は「階段」から追加します。")).toHaveCount(0);

    await itemHeader.click();
    await expect(itemHeader).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("高台へ上がる階段は「階段」から追加します。")).toBeVisible();
    // 「こんなときに使います」の箇条書き（useCases）も表示される。
    await expect(page.getByText("客席から出演者がどのように見えるか確認したい")).toBeVisible();
  });

  test("「✨ やりたいことから探す」の別項目も個別に開閉できる（他項目には影響しない）", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const spotlightHeader = page.getByRole("button", { name: /スポットライトを当てたい/ });
    await spotlightHeader.click();
    await expect(
      page.getByText("出演者を選択して、「照明の設定」から「選択中の出演者を照らす」を押すと、その出演者の位置にスポットライトを追加できます。")
    ).toBeVisible();
    // 旧文言（照明ビーム一般の追加手順）は残っていない。
    await expect(page.getByText("「照明の設定」を開き、「照明ビーム」を追加します。")).toHaveCount(0);

    // 開いていない別項目の本文は依然として見えない。
    await expect(page.getByText("高台へ上がる階段は「階段」から追加します。")).toHaveCount(0);
  });

  // Help動画 Phase 2A（試験導入・1本のみ）。
  //
  // 【注記】muted属性について：Reactは<video>のmuted propをHTML属性
  // （node.setAttribute("muted", ...)）としてではなく、DOMプロパティ
  // （node.muted = true）として反映する既知の挙動があるため、toHaveAttribute("muted", ...)
  // では検出できない場合がある。そのため、autoplay/loop/muted/playsInlineはすべて
  // toHaveJSProperty（実際のDOMプロパティ値）で検証し、preload（文字列値の通常の属性）は
  // toHaveAttributeで検証する。
  test("「高台・階段を作りたい」を開くとHelp動画（video要素）が表示され、必要な属性が設定されている", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const itemHeader = page.getByRole("button", { name: /高台・階段を作りたい/ });
    await itemHeader.click();

    // Help改善Phase：want_platformStairs専用の入口スライド付きplatform-stairs-short.mp4へ
    // 切り替えたため、srcをこちらへ更新（旧stairs-to-platform-short.mp4はwant_performerOnPlatform
    // 専用として引き続き別テストで検証する）。
    const video = page.locator('video[src="/help-videos/platform-stairs-short.mp4"]');
    await expect(video).toHaveCount(1);
    await expect(video).toHaveAttribute("preload", "metadata");
    await expect(video).toHaveJSProperty("autoplay", true);
    await expect(video).toHaveJSProperty("loop", true);
    await expect(video).toHaveJSProperty("muted", true);
    await expect(video).toHaveJSProperty("playsInline", true);
  });

  test("「高台・階段を作りたい」のaccordionを閉じるとHelp動画（video要素）がunmountされる", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const itemHeader = page.getByRole("button", { name: /高台・階段を作りたい/ });
    const video = page.locator('video[src="/help-videos/platform-stairs-short.mp4"]');

    await itemHeader.click();
    await expect(video).toHaveCount(1);

    await itemHeader.click();
    await expect(itemHeader).toHaveAttribute("aria-expanded", "false");
    await expect(video).toHaveCount(0);
  });

  // Help改善Phase：want_platformStairsを入口スライド付きplatform-stairs-short.mp4へ
  // 切り替えた後、この動画がwant_performerOnPlatformの内容にも十分適合するため、
  // want_performerOnPlatform側のsrcも同じplatform-stairs-short.mp4へ統一した
  // （sec.keyの条件自体は2項目とも独立したまま維持しており、OR条件へは戻していない）。
  // 旧stairs-to-platform-short.mp4はpublic/help-videos/内に保全されているが、
  // 現時点ではどのHelp項目からも参照されていない。
  test("「出演者を高台へ乗せたい」を開くと既存のHelp動画（video要素）が表示され、閉じるとunmountされる", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const itemHeader = page.getByRole("button", { name: /出演者を高台へ乗せたい/ });
    const video = page.locator('video[src="/help-videos/platform-stairs-short.mp4"]');

    await itemHeader.click();
    await expect(video).toHaveCount(1);
    await expect(video).toHaveAttribute("preload", "metadata");
    await expect(video).toHaveJSProperty("autoplay", true);
    await expect(video).toHaveJSProperty("loop", true);
    await expect(video).toHaveJSProperty("muted", true);
    await expect(video).toHaveJSProperty("playsInline", true);

    await itemHeader.click();
    await expect(itemHeader).toHaveAttribute("aria-expanded", "false");
    await expect(video).toHaveCount(0);
  });

  test("platform-stairs-short.mp4の動画は「高台・階段を作りたい」「出演者を高台へ乗せたい」以外の項目には存在せず、旧stairs-to-platform-short.mp4はHelp内のどこにも表示されない", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const newVideo = page.locator('video[src="/help-videos/platform-stairs-short.mp4"]');
    const oldVideo = page.locator('video[src="/help-videos/stairs-to-platform-short.mp4"]');

    // 同じセクション内の別項目（「スポットライトを当てたい」）を開いても、どちらの動画も存在しない。
    await page.getByRole("button", { name: /スポットライトを当てたい/ }).click();
    await expect(newVideo).toHaveCount(0);
    await expect(oldVideo).toHaveCount(0);

    // Beam追尾Short側の項目を開いても、どちらの動画も混入しない。
    await page.getByRole("button", { name: /ライトを出演者に追尾させたい/ }).click();
    await expect(newVideo).toHaveCount(0);
    await expect(oldVideo).toHaveCount(0);

    // 「出演者を高台へ乗せたい」もplatform-stairs-short.mp4へ統一されたため、
    // 旧stairs-to-platform-short.mp4はここにも表示されない。
    await page.getByRole("button", { name: /出演者を高台へ乗せたい/ }).click();
    await expect(oldVideo).toHaveCount(0);
  });

  // ==================================================
  // Help Short動画 共通コンポーネント（HelpShortVideo）のbehaviorテスト（UX改善Phase）
  // ==================================================
  // Help Shortはすべて同一のHelpShortVideoを使っているため、内部ロジック（一時停止／
  // 再生・動画を隠す／再表示・accordion close/reopen時のリセット）は代表1本だけで検証すれば
  // 十分とし、全項目に複製しない。代表には「高台・階段を作りたい」（platform-stairs-short.mp4。
  // Help改善Phaseでwant_platformStairs専用の入口スライド付き動画として導入し、その後
  // want_performerOnPlatformもsrcを合わせて同じ動画を参照するようにした。sec.keyの条件は
  // 2項目とも独立したまま）を引き続き選んでいる。他項目の存在確認・属性確認・
  // accordion unmount確認・非混入確認は、上記の既存テスト（置き換え後も変更していない
  // locator、およびsrc更新済みのwant_platformStairs用locator）がそのまま担保する。

  test("Test A：「⏸ 一時停止」を押すとvideoがpausedになる", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();
    await page.getByRole("button", { name: /高台・階段を作りたい/ }).click();

    const help = helpSection(page);
    const video = help.locator('video[src="/help-videos/platform-stairs-short.mp4"]');
    await expect(video).toHaveCount(1);

    const pauseButton = help.getByRole("button", { name: "一時停止", exact: true });
    await expect(pauseButton).toBeVisible();

    await pauseButton.click();

    await expect(video).toHaveJSProperty("paused", true);
    await expect(help.getByRole("button", { name: "再生", exact: true })).toBeVisible();
    await expect(help.getByRole("button", { name: "再生", exact: true })).toHaveAttribute("aria-pressed", "true");
  });

  test("Test B：「▶ 再生」を押すと再生状態へ戻る", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();
    await page.getByRole("button", { name: /高台・階段を作りたい/ }).click();

    const help = helpSection(page);
    const video = help.locator('video[src="/help-videos/platform-stairs-short.mp4"]');
    await help.getByRole("button", { name: "一時停止", exact: true }).click();
    await expect(video).toHaveJSProperty("paused", true);

    const playButton = help.getByRole("button", { name: "再生", exact: true });
    await playButton.click();

    // play()は非同期のため、状態反映をexpectのポーリングで待つ（固定waitForTimeoutは使わない）。
    await expect(video).toHaveJSProperty("paused", false);
    await expect(help.getByRole("button", { name: "一時停止", exact: true })).toBeVisible();
    await expect(help.getByRole("button", { name: "一時停止", exact: true })).toHaveAttribute("aria-pressed", "false");
  });

  test("Test C：「動画を隠す」でvideo要素がunmountされる", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();
    await page.getByRole("button", { name: /高台・階段を作りたい/ }).click();

    const help = helpSection(page);
    const video = help.locator('video[src="/help-videos/platform-stairs-short.mp4"]');
    await expect(video).toHaveCount(1);

    await help.getByRole("button", { name: "動画を隠す", exact: true }).click();

    await expect(video).toHaveCount(0);
    await expect(help.getByRole("button", { name: "動画を見る", exact: true })).toBeVisible();
    // アプリ本体側にも同じaria-label（「一時停止」等）を持つPlayback用buttonが存在するため、
    // page全体ではなく必ずhelp（Help専用の<section>）内へscopeしてcount=0を確認する。
    // 本体側のbuttonが存在すること自体は正常であり、このテストの対象外。
    await expect(help.getByRole("button", { name: "一時停止", exact: true })).toHaveCount(0);
    await expect(help.getByRole("button", { name: "再生", exact: true })).toHaveCount(0);
  });

  test("Test D：「▶ 動画を見る」でvideoが再mountされる", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();
    await page.getByRole("button", { name: /高台・階段を作りたい/ }).click();

    const help = helpSection(page);
    await help.getByRole("button", { name: "動画を隠す", exact: true }).click();
    const video = help.locator('video[src="/help-videos/platform-stairs-short.mp4"]');
    await expect(video).toHaveCount(0);

    await help.getByRole("button", { name: "動画を見る", exact: true }).click();

    await expect(video).toHaveCount(1);
    await expect(help.getByRole("button", { name: "一時停止", exact: true })).toBeVisible();
    // 新規mount直後はautoPlayで再生中になる（paused=false）。currentTimeが0秒に近いことの
    // 厳密な検証はautoplay開始直後のタイミングでflakyになり得るため行わない。
    await expect(video).toHaveJSProperty("paused", false);
  });

  test("Test E：accordionを閉じて再度開くとHelpShortVideoの状態が初期化される", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const help = helpSection(page);
    const itemHeader = help.getByRole("button", { name: /高台・階段を作りたい/ });
    await itemHeader.click();

    // 一時停止と「動画を隠す」の両方を経由させ、状態を確実に変更しておく。
    await help.getByRole("button", { name: "一時停止", exact: true }).click();
    await help.getByRole("button", { name: "動画を隠す", exact: true }).click();

    await itemHeader.click();
    await expect(itemHeader).toHaveAttribute("aria-expanded", "false");

    await itemHeader.click();

    const video = help.locator('video[src="/help-videos/platform-stairs-short.mp4"]');
    await expect(video).toHaveCount(1);
    await expect(help.getByRole("button", { name: "一時停止", exact: true })).toBeVisible();
    await expect(help.getByRole("button", { name: "動画を見る", exact: true })).toHaveCount(0);
    await expect(video).toHaveJSProperty("paused", false);
  });

  // ==================================================
  // Help動画：「スポットライトを当てたい」用Spotlight Short。上記「高台・階段を作りたい」用
  // の3件と全く同じ検証パターンを流用している（video要素の存在・必須属性／accordion閉時の
  // unmount／他項目への非混入）。共通のpause/hide behavior（Test A〜E相当）は既に代表動画
  // （高台・階段Short）で検証済みのため、ここでは重複させない。
  // ==================================================
  test("「スポットライトを当てたい」を開くとSpotlight ShortのHelp動画（video要素）が表示され、必要な属性が設定されている", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const itemHeader = page.getByRole("button", { name: /スポットライトを当てたい/ });
    await itemHeader.click();

    const video = page.locator('video[src="/help-videos/spotlight-short.mp4"]');
    await expect(video).toHaveCount(1);
    await expect(video).toHaveAttribute("preload", "metadata");
    await expect(video).toHaveAttribute("aria-label", "選択中の出演者へ固定されたスポットライトを当てる例");
    await expect(video).not.toHaveAttribute("controls", "");
    await expect(video).toHaveJSProperty("autoplay", true);
    await expect(video).toHaveJSProperty("loop", true);
    await expect(video).toHaveJSProperty("muted", true);
    await expect(video).toHaveJSProperty("playsInline", true);
  });

  test("「スポットライトを当てたい」のaccordionを閉じるとSpotlight ShortのHelp動画（video要素）がunmountされる", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const itemHeader = page.getByRole("button", { name: /スポットライトを当てたい/ });
    const video = page.locator('video[src="/help-videos/spotlight-short.mp4"]');

    await itemHeader.click();
    await expect(video).toHaveCount(1);

    await itemHeader.click();
    await expect(itemHeader).toHaveAttribute("aria-expanded", "false");
    await expect(video).toHaveCount(0);
  });

  test("Spotlight ShortのHelp動画は「スポットライトを当てたい」以外の項目には存在しない", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const video = page.locator('video[src="/help-videos/spotlight-short.mp4"]');

    // 同じセクション内の別項目（「高台・階段を作りたい」）を開いても動画は存在しない。
    await page.getByRole("button", { name: /高台・階段を作りたい/ }).click();
    await expect(video).toHaveCount(0);

    // 隣接するBeam追尾Short側の項目を開いても混入しない（独立性の確認）。
    await page.getByRole("button", { name: /ライトを出演者に追尾させたい/ }).click();
    await expect(video).toHaveCount(0);
  });

  // Help動画 Phase 4B：「ライトを出演者に追尾させたい」用Beam追尾Short。
  // 上記「高台・階段を作りたい」用の3件と全く同じ検証パターンを流用している
  // （video要素の存在・必須属性／accordion閉時のunmount／他項目への非混入）。
  test("「ライトを出演者に追尾させたい」を開くとBeam追尾のHelp動画（video要素）が表示され、必要な属性が設定されている", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const itemHeader = page.getByRole("button", { name: /ライトを出演者に追尾させたい/ });
    await itemHeader.click();

    const video = page.locator('video[src="/help-videos/beam-follow-short.mp4"]');
    await expect(video).toHaveCount(1);
    await expect(video).toHaveAttribute("preload", "metadata");
    await expect(video).toHaveJSProperty("autoplay", true);
    await expect(video).toHaveJSProperty("loop", true);
    await expect(video).toHaveJSProperty("muted", true);
    await expect(video).toHaveJSProperty("playsInline", true);
  });

  test("「ライトを出演者に追尾させたい」のaccordionを閉じるとBeam追尾のHelp動画（video要素）がunmountされる", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const itemHeader = page.getByRole("button", { name: /ライトを出演者に追尾させたい/ });
    const video = page.locator('video[src="/help-videos/beam-follow-short.mp4"]');

    await itemHeader.click();
    await expect(video).toHaveCount(1);

    await itemHeader.click();
    await expect(itemHeader).toHaveAttribute("aria-expanded", "false");
    await expect(video).toHaveCount(0);
  });

  test("Beam追尾のHelp動画は「ライトを出演者に追尾させたい」以外の項目には存在しない", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const video = page.locator('video[src="/help-videos/beam-follow-short.mp4"]');

    // 同じセクション内の別項目（「スポットライトを当てたい」）を開いても動画は存在しない。
    await page.getByRole("button", { name: /スポットライトを当てたい/ }).click();
    await expect(video).toHaveCount(0);

    // 高台・階段Short側の項目を開いても、Beam動画は混入しない（両動画の独立性の確認）。
    await page.getByRole("button", { name: /高台・階段を作りたい/ }).click();
    await expect(video).toHaveCount(0);
  });

  // Help動画 Phase 5B：「好きなカウントで照明を変えたい」用Lighting Cue Short。
  // 高台・階段Short／Beam追尾Shortと全く同じ検証パターンを流用している
  // （video要素の存在・必須属性／accordion閉時のunmount／他項目への非混入）。
  test("「好きなカウントで照明を変えたい」を開くとLighting Cue ShortのHelp動画（video要素）が表示され、必要な属性が設定されている", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const itemHeader = page.getByRole("button", { name: /好きなカウントで照明を変えたい/ });
    await itemHeader.click();

    const video = page.locator('video[src="/help-videos/lighting-cue-short.mp4"]');
    await expect(video).toHaveCount(1);
    await expect(video).toHaveAttribute("preload", "metadata");
    await expect(video).toHaveJSProperty("autoplay", true);
    await expect(video).toHaveJSProperty("loop", true);
    await expect(video).toHaveJSProperty("muted", true);
    await expect(video).toHaveJSProperty("playsInline", true);
  });

  test("「好きなカウントで照明を変えたい」のaccordionを閉じるとLighting Cue ShortのHelp動画（video要素）がunmountされる", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const itemHeader = page.getByRole("button", { name: /好きなカウントで照明を変えたい/ });
    const video = page.locator('video[src="/help-videos/lighting-cue-short.mp4"]');

    await itemHeader.click();
    await expect(video).toHaveCount(1);

    await itemHeader.click();
    await expect(itemHeader).toHaveAttribute("aria-expanded", "false");
    await expect(video).toHaveCount(0);
  });

  test("Lighting Cue ShortのHelp動画は「好きなカウントで照明を変えたい」以外の項目には存在しない", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const video = page.locator('video[src="/help-videos/lighting-cue-short.mp4"]');

    // 同じセクション内の別項目（「スポットライトを当てたい」）を開いても動画は存在しない。
    await page.getByRole("button", { name: /スポットライトを当てたい/ }).click();
    await expect(video).toHaveCount(0);

    // 他のHelp Short側の項目（高台・階段／Beam追尾）を開いても混入しない（独立性の確認）。
    await page.getByRole("button", { name: /高台・階段を作りたい/ }).click();
    await expect(video).toHaveCount(0);

    await page.getByRole("button", { name: /ライトを出演者に追尾させたい/ }).click();
    await expect(video).toHaveCount(0);
  });

  // 「照明をゆっくり変えたい」用Lighting Fade Short。既存Short（高台・階段／Beam追尾／
  // Lighting Cue）と全く同じ検証パターンを流用している（video要素の存在・必須属性／
  // accordion閉時のunmount／他項目への非混入）。
  test("「照明をゆっくり変えたい」を開くとLighting Fade ShortのHelp動画（video要素）が表示され、必要な属性が設定されている", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const itemHeader = page.getByRole("button", { name: /照明をゆっくり変えたい/ });
    await itemHeader.click();

    const video = page.locator('video[src="/help-videos/lighting-fade-short.mp4"]');
    await expect(video).toHaveCount(1);
    await expect(video).toHaveAttribute("preload", "metadata");
    await expect(video).toHaveJSProperty("autoplay", true);
    await expect(video).toHaveJSProperty("loop", true);
    await expect(video).toHaveJSProperty("muted", true);
    await expect(video).toHaveJSProperty("playsInline", true);
  });

  test("「照明をゆっくり変えたい」のaccordionを閉じるとLighting Fade ShortのHelp動画（video要素）がunmountされる", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const itemHeader = page.getByRole("button", { name: /照明をゆっくり変えたい/ });
    const video = page.locator('video[src="/help-videos/lighting-fade-short.mp4"]');

    await itemHeader.click();
    await expect(video).toHaveCount(1);

    await itemHeader.click();
    await expect(itemHeader).toHaveAttribute("aria-expanded", "false");
    await expect(video).toHaveCount(0);
  });

  test("Lighting Fade ShortのHelp動画は「照明をゆっくり変えたい」以外の項目には存在しない", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const video = page.locator('video[src="/help-videos/lighting-fade-short.mp4"]');

    // 同じセクション内の別項目（「スポットライトを当てたい」）を開いても動画は存在しない。
    await page.getByRole("button", { name: /スポットライトを当てたい/ }).click();
    await expect(video).toHaveCount(0);

    // 他のHelp Short側の項目を開いても混入しない（独立性の確認）。
    await page.getByRole("button", { name: /高台・階段を作りたい/ }).click();
    await expect(video).toHaveCount(0);

    await page.getByRole("button", { name: /ライトを出演者に追尾させたい/ }).click();
    await expect(video).toHaveCount(0);

    await page.getByRole("button", { name: /好きなカウントで照明を変えたい/ }).click();
    await expect(video).toHaveCount(0);
  });

  // 「ライトそのものを動かしたい」用Lighting Move Short。既存Short（高台・階段／Beam追尾／
  // Lighting Cue／Lighting Fade）と全く同じ検証パターンを流用している（video要素の存在・
  // 必須属性／accordion閉時のunmount／他項目への非混入）。
  test("「ライトそのものを動かしたい」を開くとLighting Move ShortのHelp動画（video要素）が表示され、必要な属性が設定されている", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const itemHeader = page.getByRole("button", { name: /ライトそのものを動かしたい/ });
    await itemHeader.click();

    const video = page.locator('video[src="/help-videos/lighting-move-short.mp4"]');
    await expect(video).toHaveCount(1);
    await expect(video).toHaveAttribute("preload", "metadata");
    await expect(video).toHaveJSProperty("autoplay", true);
    await expect(video).toHaveJSProperty("loop", true);
    await expect(video).toHaveJSProperty("muted", true);
    await expect(video).toHaveJSProperty("playsInline", true);
  });

  test("「ライトそのものを動かしたい」のaccordionを閉じるとLighting Move ShortのHelp動画（video要素）がunmountされる", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const itemHeader = page.getByRole("button", { name: /ライトそのものを動かしたい/ });
    const video = page.locator('video[src="/help-videos/lighting-move-short.mp4"]');

    await itemHeader.click();
    await expect(video).toHaveCount(1);

    await itemHeader.click();
    await expect(itemHeader).toHaveAttribute("aria-expanded", "false");
    await expect(video).toHaveCount(0);
  });

  test("Lighting Move ShortのHelp動画は「ライトそのものを動かしたい」以外の項目には存在しない", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const video = page.locator('video[src="/help-videos/lighting-move-short.mp4"]');

    // 同じセクション内の別項目（「スポットライトを当てたい」）を開いても動画は存在しない。
    await page.getByRole("button", { name: /スポットライトを当てたい/ }).click();
    await expect(video).toHaveCount(0);

    // 他のHelp Short側の項目を開いても混入しない（独立性の確認）。
    await page.getByRole("button", { name: /高台・階段を作りたい/ }).click();
    await expect(video).toHaveCount(0);

    await page.getByRole("button", { name: /ライトを出演者に追尾させたい/ }).click();
    await expect(video).toHaveCount(0);

    await page.getByRole("button", { name: /好きなカウントで照明を変えたい/ }).click();
    await expect(video).toHaveCount(0);

    await page.getByRole("button", { name: /照明をゆっくり変えたい/ }).click();
    await expect(video).toHaveCount(0);
  });

  // 「同じ照明を別の場所でも使いたい」用Lighting Copy Short。既存Short（高台・階段／
  // Beam追尾／Lighting Cue／Lighting Fade／Lighting Move）と全く同じ検証パターンを
  // 流用している（video要素の存在・必須属性／accordion閉時のunmount／他項目への非混入）。
  test("「同じ照明を別の場所でも使いたい」を開くとLighting Copy ShortのHelp動画（video要素）が表示され、必要な属性が設定されている", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const itemHeader = page.getByRole("button", { name: /同じ照明を別の場所でも使いたい/ });
    await itemHeader.click();

    const video = page.locator('video[src="/help-videos/lighting-copy-short.mp4"]');
    await expect(video).toHaveCount(1);
    await expect(video).toHaveAttribute("preload", "metadata");
    await expect(video).not.toHaveAttribute("controls", "");
    await expect(video).toHaveJSProperty("autoplay", true);
    await expect(video).toHaveJSProperty("loop", true);
    await expect(video).toHaveJSProperty("muted", true);
    await expect(video).toHaveJSProperty("playsInline", true);
  });

  test("「同じ照明を別の場所でも使いたい」のaccordionを閉じるとLighting Copy ShortのHelp動画（video要素）がunmountされる", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const itemHeader = page.getByRole("button", { name: /同じ照明を別の場所でも使いたい/ });
    const video = page.locator('video[src="/help-videos/lighting-copy-short.mp4"]');

    await itemHeader.click();
    await expect(video).toHaveCount(1);

    await itemHeader.click();
    await expect(itemHeader).toHaveAttribute("aria-expanded", "false");
    await expect(video).toHaveCount(0);
  });

  test("Lighting Copy ShortのHelp動画は「同じ照明を別の場所でも使いたい」以外の項目には存在しない", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const video = page.locator('video[src="/help-videos/lighting-copy-short.mp4"]');

    // 同じセクション内の別項目（「スポットライトを当てたい」）を開いても動画は存在しない。
    await page.getByRole("button", { name: /スポットライトを当てたい/ }).click();
    await expect(video).toHaveCount(0);

    // 他のHelp Short側の項目を開いても混入しない（独立性の確認）。
    await page.getByRole("button", { name: /高台・階段を作りたい/ }).click();
    await expect(video).toHaveCount(0);

    await page.getByRole("button", { name: /ライトを出演者に追尾させたい/ }).click();
    await expect(video).toHaveCount(0);

    await page.getByRole("button", { name: /好きなカウントで照明を変えたい/ }).click();
    await expect(video).toHaveCount(0);

    await page.getByRole("button", { name: /照明をゆっくり変えたい/ }).click();
    await expect(video).toHaveCount(0);

    await page.getByRole("button", { name: /ライトそのものを動かしたい/ }).click();
    await expect(video).toHaveCount(0);
  });

  // 「作った構成を人に見せたい」用Presentation Mode Short。既存Short（高台・階段／Beam追尾／
  // Lighting Cue／Lighting Fade／Lighting Move／Lighting Copy）と全く同じ検証パターンを
  // 流用している（video要素の存在・必須属性／accordion閉時のunmount／他項目への非混入）。
  test("「作った構成を人に見せたい」を開くとPresentation Mode ShortのHelp動画（video要素）が表示され、必要な属性が設定されている", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const itemHeader = page.getByRole("button", { name: /作った構成を人に見せたい/ });
    await itemHeader.click();

    const video = page.locator('video[src="/help-videos/presentation-short.mp4"]');
    await expect(video).toHaveCount(1);
    await expect(video).toHaveAttribute("preload", "metadata");
    await expect(video).not.toHaveAttribute("controls", "");
    await expect(video).toHaveJSProperty("autoplay", true);
    await expect(video).toHaveJSProperty("loop", true);
    await expect(video).toHaveJSProperty("muted", true);
    await expect(video).toHaveJSProperty("playsInline", true);
  });

  test("「作った構成を人に見せたい」のaccordionを閉じるとPresentation Mode ShortのHelp動画（video要素）がunmountされる", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const itemHeader = page.getByRole("button", { name: /作った構成を人に見せたい/ });
    const video = page.locator('video[src="/help-videos/presentation-short.mp4"]');

    await itemHeader.click();
    await expect(video).toHaveCount(1);

    await itemHeader.click();
    await expect(itemHeader).toHaveAttribute("aria-expanded", "false");
    await expect(video).toHaveCount(0);
  });

  test("Presentation Mode ShortのHelp動画は「作った構成を人に見せたい」以外の項目には存在しない", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const video = page.locator('video[src="/help-videos/presentation-short.mp4"]');

    // 同じセクション内の別項目（「スポットライトを当てたい」）を開いても動画は存在しない。
    await page.getByRole("button", { name: /スポットライトを当てたい/ }).click();
    await expect(video).toHaveCount(0);

    // 他のHelp Short側の項目を開いても混入しない（独立性の確認）。
    await page.getByRole("button", { name: /高台・階段を作りたい/ }).click();
    await expect(video).toHaveCount(0);

    await page.getByRole("button", { name: /ライトを出演者に追尾させたい/ }).click();
    await expect(video).toHaveCount(0);

    await page.getByRole("button", { name: /好きなカウントで照明を変えたい/ }).click();
    await expect(video).toHaveCount(0);

    await page.getByRole("button", { name: /照明をゆっくり変えたい/ }).click();
    await expect(video).toHaveCount(0);

    await page.getByRole("button", { name: /ライトそのものを動かしたい/ }).click();
    await expect(video).toHaveCount(0);

    await page.getByRole("button", { name: /同じ照明を別の場所でも使いたい/ }).click();
    await expect(video).toHaveCount(0);
  });

  // 「画像やPDFにしたい」用Export Center Short。既存Short（高台・階段／Beam追尾／Lighting Cue／
  // Lighting Fade／Lighting Move／Lighting Copy／Presentation）と全く同じ検証パターンを
  // 流用している（video要素の存在・必須属性／accordion閉時のunmount／他項目への非混入）。
  test("「画像やPDFにしたい」を開くとExport Center ShortのHelp動画（video要素）が表示され、必要な属性が設定されている", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const itemHeader = page.getByRole("button", { name: /画像やPDFにしたい/ });
    await itemHeader.click();

    const video = page.locator('video[src="/help-videos/export-short.mp4"]');
    await expect(video).toHaveCount(1);
    await expect(video).toHaveAttribute("preload", "metadata");
    await expect(video).not.toHaveAttribute("controls", "");
    await expect(video).toHaveJSProperty("autoplay", true);
    await expect(video).toHaveJSProperty("loop", true);
    await expect(video).toHaveJSProperty("muted", true);
    await expect(video).toHaveJSProperty("playsInline", true);
  });

  test("「画像やPDFにしたい」のaccordionを閉じるとExport Center ShortのHelp動画（video要素）がunmountされる", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const itemHeader = page.getByRole("button", { name: /画像やPDFにしたい/ });
    const video = page.locator('video[src="/help-videos/export-short.mp4"]');

    await itemHeader.click();
    await expect(video).toHaveCount(1);

    await itemHeader.click();
    await expect(itemHeader).toHaveAttribute("aria-expanded", "false");
    await expect(video).toHaveCount(0);
  });

  test("Export Center ShortのHelp動画は「画像やPDFにしたい」以外の項目には存在しない", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const video = page.locator('video[src="/help-videos/export-short.mp4"]');

    // 同じセクション内の別項目（「作った構成を人に見せたい」）を開いても動画は存在しない。
    await page.getByRole("button", { name: /作った構成を人に見せたい/ }).click();
    await expect(video).toHaveCount(0);

    // 他のHelp Short側の項目を開いても混入しない（独立性の確認）。
    await page.getByRole("button", { name: /高台・階段を作りたい/ }).click();
    await expect(video).toHaveCount(0);

    await page.getByRole("button", { name: /ライトを出演者に追尾させたい/ }).click();
    await expect(video).toHaveCount(0);

    await page.getByRole("button", { name: /好きなカウントで照明を変えたい/ }).click();
    await expect(video).toHaveCount(0);

    await page.getByRole("button", { name: /照明をゆっくり変えたい/ }).click();
    await expect(video).toHaveCount(0);

    await page.getByRole("button", { name: /ライトそのものを動かしたい/ }).click();
    await expect(video).toHaveCount(0);

    await page.getByRole("button", { name: /同じ照明を別の場所でも使いたい/ }).click();
    await expect(video).toHaveCount(0);
  });

  // Help文言修正：タイトルを「曲の途中で照明を変えたい」から「好きなカウントで照明を変えたい」へ
  // 変更した際に、冒頭の説明文（既存の文言のまま）が新タイトルの項目でも変わらず表示されることを確認する。
  test("「好きなカウントで照明を変えたい」を開くと、冒頭の説明文と具体例が表示される", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const itemHeader = page.getByRole("button", { name: /好きなカウントで照明を変えたい/ });
    await itemHeader.click();

    await expect(page.getByText("1つの構成の途中でも、好きなカウントで照明を変えられます。")).toBeVisible();
    await expect(
      page.getByText("たとえば、構成1の最初 → 舞台を青くする、4カウント目 → センターのスポットライトを点ける、8カウント目 → 舞台を赤くする、といった設定ができます。")
    ).toBeVisible();
    // 「照明キュー」定義callout（薄い黄色背景＋左アクセント線＋太字）が表示されることを確認。
    await expect(page.getByText("照明キュー ＝ 照明を切り替えるタイミング")).toBeVisible();
  });

  test("「🔍 機能から探す」は初期状態でCLOSEDで、開くと既存の項目が表示される", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const functionsHeader = page.getByRole("button", { name: /機能から探す/ });
    await expect(functionsHeader).toBeVisible();
    await expect(functionsHeader).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("button", { name: /^▶?\s*🎭\s*ステージ$/ })).toHaveCount(0);

    await functionsHeader.click();
    await expect(functionsHeader).toHaveAttribute("aria-expanded", "true");

    const stageSection = page.getByRole("button", { name: /ステージ$/ });
    await expect(stageSection).toBeVisible();
    await stageSection.click();
    await expect(
      page.getByText("「全体の設定 → ステージ設定」で舞台の幅・奥行を設定できます。")
    ).toBeVisible();
  });

  test("「⌨️ ショートカット」は初期状態でCLOSEDで、開くと既存のショートカット一覧が表示される", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const shortcutsHeader = page.getByRole("button", { name: /ショートカット/ });
    await expect(shortcutsHeader).toBeVisible();
    await expect(shortcutsHeader).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("元に戻す")).toHaveCount(0);

    await shortcutsHeader.click();
    await expect(shortcutsHeader).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("元に戻す")).toBeVisible();
    await expect(page.getByText("Cmd/Ctrl + Z")).toBeVisible();
  });

  test("「音楽に合わせて構成を作りたい①」が「やりたいことから探す」の先頭にあり、初期CLOSEDで開くと新しい説明が表示される", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    // 「やりたいことから探す」内の13項目のうち、DOM順で先頭に来るものを取得する。
    const wantToDoItemTitles =
      /音楽に合わせて構成を作りたい①|音楽に合わせて構成を作りたい②|高台・階段を作りたい|出演者を高台へ乗せたい|照明を当てたい|スポットライトを当てたい|ライトを出演者に追尾させたい|好きなカウントで照明を変えたい|照明をゆっくり変えたい|ライトそのものを動かしたい|同じ照明を別の場所でも使いたい|作った構成を人に見せたい|画像やPDFにしたい/;
    const firstItemHeader = page.getByRole("button", { name: wantToDoItemTitles }).first();
    await expect(firstItemHeader).toHaveAccessibleName(/音楽に合わせて構成を作りたい①/);

    const musicSyncHeader = page.getByRole("button", { name: "🎵 音楽に合わせて構成を作りたい①" });
    await expect(musicSyncHeader).toBeVisible();
    await expect(musicSyncHeader).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("まず、音源を読み込み、曲のテンポを設定します。")).toHaveCount(0);

    await musicSyncHeader.click();
    await expect(musicSyncHeader).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("まず、音源を読み込み、曲のテンポを設定します。")).toBeVisible();
    await expect(page.getByText("BPMの違う複数の楽曲をつないだ音源で構成を作りたい")).toBeVisible();
    await expect(page.getByText("曲ごと／区間ごとにテンポを設定したい")).toBeVisible();
    // 振付の時間管理のuseCaseは②へ移したため、①を開いた状態では表示されない。
    await expect(
      page.getByText("「8カウントキープ → 4カウント移動」のように振付の時間を管理したい")
    ).toHaveCount(0);
  });

  test("「音楽に合わせて構成を作りたい②」も個別に開閉でき、旧タイトルは残っていない", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const musicPositionHeader = page.getByRole("button", { name: "🎵 音楽に合わせて構成を作りたい②" });
    await expect(musicPositionHeader).toBeVisible();
    await expect(musicPositionHeader).toHaveAttribute("aria-expanded", "false");

    await musicPositionHeader.click();
    await expect(musicPositionHeader).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.getByText("次に、各構成が曲のどの位置に対応するかを設定し、音楽と同期して確認します。")
    ).toBeVisible();
    await expect(
      page.getByText("各構成の「音楽位置」で、その構成が曲の何曲目・何エイト目・何カウント目に対応するかを設定できます。")
    ).toBeVisible();
    await expect(
      page.getByText("「8カウントキープ → 4カウント移動」のように振付の時間を管理したい")
    ).toBeVisible();
    await expect(page.getByText("実際の曲を流しながらフォーメーションを確認したい")).toBeVisible();

    // 別の音楽項目（音楽に合わせて構成を作りたい①）は依然として閉じたまま。
    await expect(
      page.getByRole("button", { name: "🎵 音楽に合わせて構成を作りたい①" })
    ).toHaveAttribute("aria-expanded", "false");

    // 旧タイトル「構成と曲の位置を合わせたい」はHelp項目として残っていない。
    await expect(page.getByRole("button", { name: "構成と曲の位置を合わせたい", exact: true })).toHaveCount(0);
  });

  // Help動画：「音楽に合わせて構成を作りたい①②」のスライドショー版動画。既存Short
  // （高台・階段等）と同じくHelpShortVideo共通コンポーネントを使っているため、
  // 存在・src確認のみとし、pause/hide等の共通behaviorは代表動画（高台・階段Short）側の
  // Test A〜Eで検証済みのため重複させない。
  test("「音楽に合わせて構成を作りたい①」を開くとMusic動画（video要素）が正しいsrcで表示される", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    await page.getByRole("button", { name: "🎵 音楽に合わせて構成を作りたい①" }).click();

    const video = page.locator('video[src="/help-videos/music-help-01-short.mp4"]');
    await expect(video).toHaveCount(1);
  });

  test("「音楽に合わせて構成を作りたい②」を開くとMusic動画（video要素）が正しいsrcで表示される", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    await page.getByRole("button", { name: "🎵 音楽に合わせて構成を作りたい②" }).click();

    const video = page.locator('video[src="/help-videos/music-help-02-short.mp4"]');
    await expect(video).toHaveCount(1);
  });


  test("「照明を当てたい」が存在し、旧「舞台全体を色で照らしたい」は無くなっている", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    await expect(page.getByRole("button", { name: /舞台全体を色で照らしたい/ })).toHaveCount(0);

    const lightingIntroHeader = page.getByRole("button", { name: "💡 照明を当てたい" });
    await expect(lightingIntroHeader).toBeVisible();
    await expect(lightingIntroHeader).toHaveAttribute("aria-expanded", "false");

    await lightingIntroHeader.click();
    await expect(lightingIntroHeader).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.getByText("照明エリア：舞台上の範囲を、色や明るさをつけて照らします。", { exact: false })
    ).toBeVisible();
    await expect(
      page.getByText("照明ビーム：ライトの発光元から照射先へ、光の筋を表示します。", { exact: false })
    ).toBeVisible();
  });

  // Help動画：「照明を当てたい」用Lighting Intro Short。既存のMusic Help①②の動画テストと
  // 同じ思想で、存在と正しいsrcの確認のみとする。pause/hide等の共通behaviorは代表動画
  // （高台・階段Short）側のTest A〜Eで検証済みのため重複させない。
  test("「照明を当てたい」を開くとLighting Intro ShortのHelp動画（video要素）が正しいsrcで表示される", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    await page.getByRole("button", { name: "💡 照明を当てたい" }).click();

    const video = page.locator('video[src="/help-videos/lighting-intro-short.mp4"]');
    await expect(video).toHaveCount(1);
  });

  test("既存の他の「やりたいこと」項目（高台・照明追尾・出力等）が失われていない", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    for (const title of [
      "🧱 高台・階段を作りたい",
      "🪜 出演者を高台へ乗せたい",
      "ライトを出演者に追尾させたい",
      "好きなカウントで照明を変えたい",
      "照明をゆっくり変えたい",
      "ライトそのものを動かしたい",
      "同じ照明を別の場所でも使いたい",
      "作った構成を人に見せたい",
      "画像やPDFにしたい",
    ]) {
      await expect(page.getByRole("button", { name: title })).toBeVisible();
    }
  });

  test("「🔍 機能から探す → ステージ」に高台・階段の説明が追加され、舞台の外観の階層表記が修正されている", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();
    const help = helpSection(page);
    await help.getByRole("button", { name: /機能から探す/ }).click();
    await help.getByRole("button", { name: /ステージ$/ }).click();

    // 「舞台の外観」の階層表記修正（全体の設定 → ステージ設定 → 舞台の外観）。
    await expect(
      help.getByText("「全体の設定 → ステージ設定 → 舞台の外観」で床・壁の色を設定できます。")
    ).toBeVisible();
    await expect(help.getByText("「全体の設定 → 舞台の外観」で床・壁の色を設定できます。")).toHaveCount(0);

    // 高台の説明。
    await expect(
      help.getByText("「高台・段差」から、舞台上に高さのある場所（高台）を追加できます。", { exact: false })
    ).toBeVisible();

    // 階段の説明：接続元・接続先・階段上の高さ変化。
    await expect(help.getByText("「接続元」「接続先」でどの舞台面同士をつなぐか指定します。", { exact: false })).toBeVisible();
    await expect(
      help.getByText("階段の上を移動すると位置に合わせて高さも変化します。", { exact: false })
    ).toBeVisible();
  });

  test("「🔍 機能から探す → 出演者」に「舞台面」の説明が追加されている", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();
    const help = helpSection(page);
    await help.getByRole("button", { name: /機能から探す/ }).click();
    await help.getByRole("button", { name: /出演者$/ }).click();

    await expect(
      help.getByText("通常は「自動」のままで、出演者の位置に合わせて通常舞台・高台・階段のどこにいるかを自動で判断します。", { exact: false })
    ).toBeVisible();
    await expect(
      help.getByText("「舞台面」を「自動」から「通常舞台」に変更すると、高台と位置が重なっていても通常舞台の高さとして扱えます。", { exact: false })
    ).toBeVisible();
    await expect(
      help.getByText("特定の高台の上に固定したい場合は、「舞台面」からその高台を直接選択できます。", { exact: false })
    ).toBeVisible();
    await expect(
      help.getByText("「選択中の出演者の舞台面」からまとめて変更することもできます。", { exact: false })
    ).toBeVisible();
  });

  test("「🌱 はじめての方へ」の俯瞰客席ビュードラッグに関する旧誤情報が修正されている", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();
    const help = helpSection(page);
    await help.getByRole("button", { name: /はじめての方へ/ }).click();

    await expect(help.getByText("平面図上でドラッグして、立ち位置を決めます。", { exact: false })).toBeVisible();
    await expect(
      help.getByText("俯瞰客席ビューでは、客席から見た高さや重なり方を確認できます。", { exact: false })
    ).toBeVisible();
    // 旧誤情報（俯瞰客席ビューでドラッグして立ち位置を決められる、という表現）は残っていない。
    await expect(
      help.getByText("平面図または俯瞰客席ビュー上でドラッグして、立ち位置を決めます。")
    ).toHaveCount(0);
  });

  test("「🔍 機能から探す → 照明」が高台・階段対応の内容に更新され、既存のCue/Fade説明も残っている", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();
    const help = helpSection(page);
    await help.getByRole("button", { name: /機能から探す/ }).click();
    await help.getByRole("button", { name: /照明$/ }).click();

    // 照明エリアの照射面・高台対応。
    await expect(
      help.getByText("「照射面」を設定すると、通常舞台だけでなく高台の上にも配置でき、高台を選んだ場合は俯瞰客席ビューでもその高さに合わせて表示されます。", { exact: false })
    ).toBeVisible();
    // 照明ビームの照射面・高台対応。
    await expect(
      help.getByText("「照射面」を設定すると、通常舞台だけでなく高台を照らすこともでき", { exact: false })
    ).toBeVisible();
    // 追尾ビームが階段・高台の高さに追従する説明。
    await expect(
      help.getByText("通常舞台から階段を上って高台へ移動する場合も、出演者の高さに合わせて照射先が変化します。", { exact: false })
    ).toBeVisible();
    await expect(
      help.getByText("追尾中は、照射面を個別に設定する必要はありません。", { exact: false })
    ).toBeVisible();
    // 既存のキープ中／移動中／フェードの説明が失われていない。
    await expect(help.getByText("構成を維持している間（キープ中）", { exact: false })).toBeVisible();
    await expect(help.getByText("次の構成へ移動している間（移動中）", { exact: false })).toBeVisible();
    await expect(help.getByText("キューごとにフェード時間を設定できます。", { exact: false })).toBeVisible();
    // Moveの存在。
    await expect(
      help.getByText("「移動」は照らす位置の変化です。", { exact: false })
    ).toBeVisible();
    // 開始フェードの補足説明（直前の照明から、その構成の開始時の照明へ徐々に変化する旨）。
    await expect(
      help.getByText("「開始フェード」を設定すると、直前の照明から、その構成の開始時の照明へ徐々に変化します。", { exact: false })
    ).toBeVisible();
  });

  test("「🔍 機能から探す → 再生」にスクラバーの説明が追加され、既存の再生説明も残っている", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();
    const help = helpSection(page);
    await help.getByRole("button", { name: /機能から探す/ }).click();
    await help.getByRole("button", { name: /再生$/ }).click();

    await expect(
      help.getByText("スクラバーを動かすと、再生しなくても、構成間の移動途中の状態を好きな位置で確認できます。", { exact: false })
    ).toBeVisible();
    // 既存の説明が失われていない。
    await expect(help.getByText("通常再生：単発の移動、または連続再生ができます。")).toBeVisible();
    await expect(help.getByText("再生中は一時停止・再開ができます。")).toBeVisible();
  });

  test("「🔍 機能から探す → 表示」にFullscreenの説明が追加されている", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();
    const help = helpSection(page);
    await help.getByRole("button", { name: /機能から探す/ }).click();
    await help.getByRole("button", { name: /表示$/ }).click();

    await expect(help.getByText("プレゼンモードでは全画面表示も利用できます。")).toBeVisible();
    await expect(help.getByText("プレゼンモードでは編集用のUIを隠し、再生に専念できます。")).toBeVisible();
  });

  test("「🔍 機能から探す → 出力」に「出演者一覧を先頭に付ける」の説明が追加され、既存説明も残っている", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();
    const help = helpSection(page);
    await help.getByRole("button", { name: /機能から探す/ }).click();
    await help.getByRole("button", { name: /出力$/ }).click();

    await expect(help.getByText("PDFでは、出演者一覧を先頭ページに付けて出力することもできます。")).toBeVisible();
    // 既存の説明が失われていない。
    await expect(help.getByText("出演者一覧のみの出力にも対応しています。")).toBeVisible();
    await expect(help.getByText("照明キューごとの出力にも対応しています。")).toBeVisible();
    await expect(help.getByText("移動軌跡・追尾スポット軌跡・出演者名・音源内時間の表示をそれぞれON/OFFできます。")).toBeVisible();
  });

  test("Helpを開いても他の右編集パネル（全体の設定等）の表示に影響しない", async ({ page }) => {
    await openFreshApp(page);
    await expect(page.getByRole("button", { name: /全体の設定/ })).toBeVisible();

    await helpToggleButton(page).click();
    await expect(page.getByRole("heading", { name: "ダンス舞台シミュレーター", level: 2 })).toBeVisible();
    await expect(page.getByRole("button", { name: /全体の設定/ })).toBeVisible();

    await helpToggleButton(page).click();
    await expect(page.getByRole("button", { name: /全体の設定/ })).toBeVisible();
  });
});

