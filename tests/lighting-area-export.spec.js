// Lighting Area Export v1・Playwrightテスト
//
// 目的（AB章）：PNG/PDF Exportの「生成が正常に完了すること」を最低限確認する。
// 「Areaの色が特定pixelに存在する」等のPNG画素解析は行わない（AB章の方針通り）。
//
// 前提：tests/lighting-area.spec.js と同じ画面操作でLighting ON→Scene追加→Area追加を行う。
// このファイル単体で完結させるため、helperは意図的に最小限だけ複製している
// （tests/lighting-area.spec.jsのhelperと重複する部分はあるが、spec間の相互import は
// Playwrightの一般的な構成として避けた）。既存プロジェクトに共通helperファイルがある場合は、
// そちらへ集約することを検討してください。
//
// Export Centerの実際のUI文言（App.jsx確認済み）：
//   - ツールバーの出力ボタン：aria-label="出力"
//   - 「出力する構成」：現在の構成（構成N） / 構成を選択 / すべての構成（全N構成）
//   - 「形式」：PNG（1構成なら画像、複数構成ならZIP） / PDF（1ファイル・複数構成は複数ページ）
//   - 確定ボタンのラベルは状態により動的に変わる（「出力」「PDFを出力」等）ため、
//     ここでは download イベントの発火だけを確認し、ボタンの正確な文言には依存しない。

import { test, expect } from "@playwright/test";
import fs from "fs";

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

function currentSceneSection(page) {
  return page.locator("section", {
    has: page.getByRole("heading", { name: "現在の構成の照明" }),
  });
}

async function enableLighting(page) {
  await page.getByLabel("照明機能を使う").check();
}

async function addLightingScene(page) {
  await currentSceneSection(page).getByRole("button", { name: "＋ この構成に照明設定を追加" }).click();
}

async function addLightingArea(page) {
  const section = currentSceneSection(page);
  const existingCount = await section.getByRole("button", { name: /^照明エリア \d+$/ }).count();
  await section.getByRole("button", { name: "＋ 照明エリアを追加" }).click();
  await section.getByRole("button", { name: `照明エリア ${existingCount + 1}` }).click();
}

async function setupSceneWithOneArea(page) {
  await openFreshApp(page);
  await enableLighting(page);
  await addLightingScene(page);
  await addLightingArea(page);
}

// Export Centerを開く（ツールバーの「出力」ボタン、aria-label="出力"）。
async function openExportCenter(page) {
  await page.getByRole("button", { name: "出力" }).click();
}

// Export Center内で形式を選択する（"png" | "pdf"）。
async function selectExportFormat(page, format) {
  const label = format === "pdf" ? /^PDF/ : /^PNG/;
  await page.getByRole("radio", { name: label, exact: true }).check();
}

// Export Center内でビューを選択する（"top" | "front"）。既定の「現在のビュー」に依存せず、
// テストごとに明示的に平面図／俯瞰客席を選び直すことで、編集画面側の表示状態に
// テスト結果が左右されないようにする。
async function selectExportView(page, view) {
  const label = view === "front" ? "俯瞰客席" : "平面図";
  await page.getByRole("radio", { name: label, exact: true }).check();
}

// Export Centerの確定ボタンをクリックし、ダウンロードが発火することを待つ。
// ボタンの正確な文言は状態により動的に変わるため、Export Centerモーダル内の
// 「有効な（disabledでない）ボタンのうち、キャンセル以外」という位置づけで取得する。
async function confirmExportAndWaitDownload(page) {
  const downloadPromise = page.waitForEvent("download");
  // 確定ボタンは「キャンセル」ボタンの直後にある、disabledでない唯一のボタン。
  // exportConfirmLabelは「出力」「PDFを出力」「N構成を出力」等に変わるため、正規表現で
  // 「出力」を含むボタンとして取得する（「キャンセル」ボタンとは文言が重ならない）。
  await page.getByRole("button", { name: /出力/ }).last().click();
  const download = await downloadPromise;
  return download;
}

// ダウンロードされたファイルの中身をBufferとして取得する。Playwrightのdownload.path()は
// ダウンロードが完了したファイルのローカルパスを返すため、fs.readFileSyncでそのまま
// バイト列を読める（画像デコードライブラリを新たに導入しない、最小限の検証手段）。
async function downloadToBuffer(download) {
  const filePath = await download.path();
  if (!filePath) {
    throw new Error("ダウンロードされたファイルのパスを取得できませんでした（playwright.configのacceptDownloads設定を確認してください）。");
  }
  return fs.readFileSync(filePath);
}

test.describe("Lighting Area Export v1", () => {
  // ------------------------------------------------------------------
  // 1. Lighting AreaありのFormationでもPNG Exportが生成できる
  // ------------------------------------------------------------------
  test("Lighting AreaありのFormationでもPNG Exportが生成できる", async ({ page }) => {
    await setupSceneWithOneArea(page);

    await openExportCenter(page);
    await selectExportFormat(page, "png");
    const download = await confirmExportAndWaitDownload(page);

    expect(download.suggestedFilename()).toMatch(/\.png$/i);
  });

  // ------------------------------------------------------------------
  // 2. Lighting AreaありのFormationでもPDF Exportが生成できる
  // ------------------------------------------------------------------
  test("Lighting AreaありのFormationでもPDF Exportが生成できる", async ({ page }) => {
    await setupSceneWithOneArea(page);

    await openExportCenter(page);
    await selectExportFormat(page, "pdf");
    const download = await confirmExportAndWaitDownload(page);

    expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
  });

  // ------------------------------------------------------------------
  // 3. Lighting OFFでもExportが正常生成される
  // ------------------------------------------------------------------
  test("Lighting OFFでもExportが正常生成される", async ({ page }) => {
    await setupSceneWithOneArea(page);
    // Lighting機能自体をOFFにする（Areaデータは保持されたまま、Exportには出さない想定）
    await page.getByLabel("照明機能を使う").uncheck();

    await openExportCenter(page);
    await selectExportFormat(page, "png");
    const download = await confirmExportAndWaitDownload(page);

    expect(download.suggestedFilename()).toMatch(/\.png$/i);
  });

  // ------------------------------------------------------------------
  // 4. Scene OFFでもExportが正常生成される
  // ------------------------------------------------------------------
  test("Scene OFFでもExportが正常生成される", async ({ page }) => {
    await setupSceneWithOneArea(page);
    const section = currentSceneSection(page);
    // 「この構成の照明を有効にする」をOFF（Scene.enabled = false）
    await section.getByLabel("この構成の照明を有効にする").uncheck();

    await openExportCenter(page);
    await selectExportFormat(page, "png");
    const download = await confirmExportAndWaitDownload(page);

    expect(download.suggestedFilename()).toMatch(/\.png$/i);
  });

  // ------------------------------------------------------------------
  // 5. 旧Scene相当（Sceneはあるがareasが空）でもExportがクラッシュしない
  // ------------------------------------------------------------------
  // 注：実際の「areasフィールド自体が存在しない旧保存データ」を直接再現するには
  // localStorageへ手動でwork構造を注入する必要があり、内部データ構造への依存度が
  // 高くなりすぎるため（P章の方針にも反する）、ここでは「Sceneは存在するがAreaを
  // 1件も追加していない状態」で代替する。App.jsx側のgetLightingAreas()は
  // 「areasフィールドが無い場合」と「areasが空配列の場合」を全く同じ経路で
  // フォールバックするため、実質的に同じコードパスを検証できる。
  test("SceneがあってもAreaが0件ならExportがクラッシュしない", async ({ page }) => {
    await openFreshApp(page);
    await enableLighting(page);
    await addLightingScene(page); // Areaは追加しない

    await openExportCenter(page);
    await selectExportFormat(page, "png");
    const download = await confirmExportAndWaitDownload(page);

    expect(download.suggestedFilename()).toMatch(/\.png$/i);
  });

  // ------------------------------------------------------------------
  // 回帰検出強化：download発火だけでなく、Areaが実際にCanvasへ描画されたことを
  // PNGバイト列の比較で検出する。画像デコードライブラリは使わず、
  // 「Areaの有無でPNGファイルのバイト列が完全一致しないこと」を確認する
  // シンプルな手法（golden file比較と同じ考え方）。
  //
  // これは実機で報告された不具合（編集画面にはAreaが3件表示されるのに、
  // 出力PNGには一切描画されない）を検出できなかった既存テストの弱点を補うためのもの。
  // ------------------------------------------------------------------

  test("平面図PNG：Lighting ON（Scene有効・Areaあり）とLighting OFFで内容が異なる", async ({ page }) => {
    await setupSceneWithOneArea(page);

    await openExportCenter(page);
    await selectExportView(page, "top");
    await selectExportFormat(page, "png");
    const downloadOn = await confirmExportAndWaitDownload(page);
    const bytesOn = await downloadToBuffer(downloadOn);

    // 同じFormation・同じ出演者配置のまま、Lighting機能だけをOFFにする
    // （Areaデータ自体は削除されない。Export内容だけが変わるはず）。
    await page.getByLabel("照明機能を使う").uncheck();

    await openExportCenter(page);
    await selectExportView(page, "top");
    await selectExportFormat(page, "png");
    const downloadOff = await confirmExportAndWaitDownload(page);
    const bytesOff = await downloadToBuffer(downloadOff);

    // Areaが実際に描画されていれば、PNGのバイト列は完全には一致しないはず。
    // （床色・出演者・グリッド等は同一のままAreaの塗りだけが消えるため、
    // 完全一致＝Areaが全く描画されていない、という強いシグナルになる）
    expect(bytesOn.equals(bytesOff)).toBe(false);
  });

  test("俯瞰PNG：Lighting ON（Scene有効・Areaあり）とLighting OFFで内容が異なる", async ({ page }) => {
    await setupSceneWithOneArea(page);

    await openExportCenter(page);
    await selectExportView(page, "front");
    await selectExportFormat(page, "png");
    const downloadOn = await confirmExportAndWaitDownload(page);
    const bytesOn = await downloadToBuffer(downloadOn);

    await page.getByLabel("照明機能を使う").uncheck();

    await openExportCenter(page);
    await selectExportView(page, "front");
    await selectExportFormat(page, "png");
    const downloadOff = await confirmExportAndWaitDownload(page);
    const bytesOff = await downloadToBuffer(downloadOff);

    expect(bytesOn.equals(bytesOff)).toBe(false);
  });

  test("平面図PNG：Scene有効／Scene無効（Areaは同じ）でPNGの内容が異なる", async ({ page }) => {
    // このテストは「サイドバーのArea一覧はScene.enabledに関わらず表示される」という
    // 編集UIの仕様（Q章）と、「ExportはScene.enabled===trueの場合のみAreaを描画する」という
    // Export側の仕様（F章）の境界を直接検証する。もしScene無効時にもExportへAreaが
    // 漏れてしまう回帰が起きた場合、あるいは逆にScene有効時にAreaが描画されない回帰が
    // 起きた場合の両方を、このテスト1つで検出できる。
    await setupSceneWithOneArea(page);
    const section = currentSceneSection(page);

    await openExportCenter(page);
    await selectExportView(page, "top");
    await selectExportFormat(page, "png");
    const downloadEnabled = await confirmExportAndWaitDownload(page);
    const bytesEnabled = await downloadToBuffer(downloadEnabled);

    // Scene自体はそのまま、「この構成の照明を有効にする」だけをOFFにする
    // （lightingEnabledはONのまま・Areaデータもそのまま）。
    await section.getByLabel("この構成の照明を有効にする").uncheck();

    await openExportCenter(page);
    await selectExportView(page, "top");
    await selectExportFormat(page, "png");
    const downloadDisabled = await confirmExportAndWaitDownload(page);
    const bytesDisabled = await downloadToBuffer(downloadDisabled);

    expect(bytesEnabled.equals(bytesDisabled)).toBe(false);
  });

  // ------------------------------------------------------------------
  // 補足：Lighting Sceneが全く存在しないFormationでもExportが正常に動くこと
  // （旧Project／Lighting未使用のFormationの互換性確認）
  // ------------------------------------------------------------------
  test("Lighting Sceneが存在しないFormationでもExportが正常生成される", async ({ page }) => {
    await openFreshApp(page);
    // Lighting機能自体に一切触れない（デフォルトOFF・Scene未作成のまま）

    await openExportCenter(page);
    await selectExportFormat(page, "png");
    const download = await confirmExportAndWaitDownload(page);

    expect(download.suggestedFilename()).toMatch(/\.png$/i);
  });
});
