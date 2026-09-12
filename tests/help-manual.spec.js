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
    await expect(page.getByText("「照明の設定」を開き、「照明ビーム」を追加します。")).toBeVisible();

    // 開いていない別項目の本文は依然として見えない。
    await expect(page.getByText("高台へ上がる階段は「階段」から追加します。")).toHaveCount(0);
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

  test("「音楽に合わせて構成を作りたい」が「やりたいことから探す」の先頭にあり、初期CLOSEDで開くと新しい説明が表示される", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    // 「やりたいことから探す」内の13項目のうち、DOM順で先頭に来るものを取得する。
    const wantToDoItemTitles =
      /音楽に合わせて構成を作りたい|構成と曲の位置を合わせたい|高台・階段を作りたい|出演者を高台へ乗せたい|照明を当てたい|スポットライトを当てたい|ライトを出演者に追尾させたい|曲の途中で照明を変えたい|照明をゆっくり変えたい|ライトそのものを動かしたい|同じ照明を別の場所でも使いたい|作った構成を人に見せたい|画像やPDFにしたい/;
    const firstItemHeader = page.getByRole("button", { name: wantToDoItemTitles }).first();
    await expect(firstItemHeader).toHaveAccessibleName(/音楽に合わせて構成を作りたい/);

    const musicSyncHeader = page.getByRole("button", { name: "🎵 音楽に合わせて構成を作りたい" });
    await expect(musicSyncHeader).toBeVisible();
    await expect(musicSyncHeader).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("音源を読み込むと、曲を流しながら構成のキープや移動を確認できます。")).toHaveCount(0);

    await musicSyncHeader.click();
    await expect(musicSyncHeader).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("音源を読み込むと、曲を流しながら構成のキープや移動を確認できます。")).toBeVisible();
    await expect(page.getByText("BPMの違う複数の楽曲をつないだ音源で構成を作りたい")).toBeVisible();
  });

  test("「構成と曲の位置を合わせたい」も個別に開閉できる", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    const musicPositionHeader = page.getByRole("button", { name: "⏱ 構成と曲の位置を合わせたい" });
    await expect(musicPositionHeader).toBeVisible();
    await expect(musicPositionHeader).toHaveAttribute("aria-expanded", "false");

    await musicPositionHeader.click();
    await expect(musicPositionHeader).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.getByText("各構成の「音楽位置」を設定すると、その構成が曲の何分何秒あたりに対応するのかを決められます。")
    ).toBeVisible();

    // 別の音楽項目（音楽に合わせて構成を作りたい）は依然として閉じたまま。
    await expect(
      page.getByRole("button", { name: "🎵 音楽に合わせて構成を作りたい" })
    ).toHaveAttribute("aria-expanded", "false");
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

  test("既存の他の「やりたいこと」項目（高台・照明追尾・出力等）が失われていない", async ({ page }) => {
    await openFreshApp(page);
    await helpToggleButton(page).click();

    for (const title of [
      "🧱 高台・階段を作りたい",
      "🪜 出演者を高台へ乗せたい",
      "ライトを出演者に追尾させたい",
      "曲の途中で照明を変えたい",
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

