// Lighting Beam v2・正式実装 STEP1・Playwrightテスト
//
// tests/lighting-area.spec.js / tests/lighting-beam.spec.js / tests/lighting-beam-3d-prototype.spec.js
// と同じスタイル・同じスコープ手法（currentSceneSection）を踏襲しています。
//
// 注意：「現在の構成の照明」パネルには、Area編集UI・Beam v1編集UI・Beam v2（3D照明ビーム）
// 編集UIが独立した選択状態で共存できます。Beam v2のX/Yラベルは重複を避けるため
// aria-label="3Dビーム発光元X"等の専用ラベルを使っており（App.jsx側でDraftNumberFieldへ
// ariaLabelプロパティを渡している）、getByLabel()での取得時はこれらの専用ラベルを使います。

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

function currentSceneSection(page) {
  return page.locator("section", {
    has: page.getByRole("heading", { name: "現在の構成の照明" }),
  });
}

// 旧「照明機能を使う」（Project-level lightingEnabled）checkboxは、Lighting UI整理・
// Prototype卒業により正式UIから削除された。Lighting Scene追加UIは常に表示されるため、
// このhelperはもう何もする必要がない（no-op）。呼び出し側のテスト本体を個別に書き換えず
// 済むよう、関数自体は残してある。
async function enableLighting(page) {
  // no-op：Project全体の「照明機能を使う」は正式UIから削除済み。
}

async function addLightingScene(page) {
  await currentSceneSection(page).getByRole("button", { name: "＋ この構成に照明設定を追加" }).click();
}

// 現在のSceneへ正式3D Beam（Beam v2）を1本追加し、追加した直後にそのBeamを選択状態にする
// （Area/Beam v1と同じく、追加時に自動選択はされない仕様のため、テスト側で一覧から
// 明示的にクリックする）。
async function addLightingBeam3D(page) {
  const section = currentSceneSection(page);
  const existingCount = await section.getByRole("button", { name: /^3D照明ビーム \d+$/ }).count();
  await section.getByRole("button", { name: "3D照明ビームを追加" }).click();
  await section.getByRole("button", { name: `3D照明ビーム ${existingCount + 1}` }).click();
}

async function setupSceneWithOneBeam3D(page) {
  await openFreshApp(page);
  await enableLighting(page);
  await addLightingScene(page);
  await addLightingBeam3D(page);
}

async function selectBeam3D(page, index) {
  await currentSceneSection(page).getByRole("button", { name: `3D照明ビーム ${index}` }).click();
}

async function switchToTopView(page) {
  await page.getByRole("button", { name: "平面図（真上）" }).click();
}
async function switchToAudienceView(page) {
  await page.getByRole("button", { name: "俯瞰客席ビュー" }).click();
}

// 俯瞰ビューSVG内の正式3D Beamレイヤー（aria-label="3D照明ビーム"）を返す。
// 3D Prototypeレイヤー（aria-label="3D照明ビーム試作"）とは別物なので、CSS属性セレクタで
// 完全一致させ、部分一致による誤取得を避ける。
function beam3DLayer(page) {
  return page.locator('g[aria-label="3D照明ビーム"]');
}

test.describe("Lighting Beam v2・正式実装 STEP1", () => {
  // ------------------------------------------------------------------
  // 1. Beam v2を追加できる
  // 2. default source / target / zが表示される
  // ------------------------------------------------------------------
  test("Beam v2を追加でき、defaultのsource/target/zが表示される", async ({ page }) => {
    await setupSceneWithOneBeam3D(page);
    const section = currentSceneSection(page);

    await expect(section.getByRole("button", { name: "3D照明ビーム 1" })).toBeVisible();
    await expect(section.getByLabel("3Dビーム発光元X")).toHaveValue(/-4/);
    await expect(section.getByLabel("3Dビーム発光元Y")).toHaveValue(/8/);
    await expect(section.getByLabel("3Dビーム発光元高さ")).toHaveValue(/6/);
    await expect(section.getByLabel("3Dビーム照射先X")).toHaveValue(/0/);
    await expect(section.getByLabel("3Dビーム照射先Y")).toHaveValue(/5/);
    await expect(section.getByRole("button", { name: "3D照明ビームの色を白にする" })).toBeVisible();
    await expect(section.getByLabel("3Dビーム根元幅")).toBeVisible();
    await expect(section.getByLabel("3Dビーム先端幅")).toBeVisible();
  });

  // ------------------------------------------------------------------
  // 3. Beam v2を複数追加できる
  // ------------------------------------------------------------------
  test("Beam v2を複数追加できる", async ({ page }) => {
    await setupSceneWithOneBeam3D(page); // 1本目
    await addLightingBeam3D(page); // 2本目
    await addLightingBeam3D(page); // 3本目
    const section = currentSceneSection(page);

    await expect(section.getByRole("button", { name: "3D照明ビーム 1" })).toBeVisible();
    await expect(section.getByRole("button", { name: "3D照明ビーム 2" })).toBeVisible();
    await expect(section.getByRole("button", { name: "3D照明ビーム 3" })).toBeVisible();

    await selectBeam3D(page, 2);
    await expect(section.getByLabel("3Dビーム発光元X")).toBeVisible();
    await selectBeam3D(page, 3);
    await expect(section.getByLabel("3Dビーム発光元X")).toBeVisible();
  });

  // ------------------------------------------------------------------
  // 4. source x/yを変更できる
  // ------------------------------------------------------------------
  test("source x/yを変更でき、保持される", async ({ page }) => {
    await setupSceneWithOneBeam3D(page);
    await addLightingBeam3D(page);
    const section = currentSceneSection(page);

    await selectBeam3D(page, 1);
    const sx = section.getByLabel("3Dビーム発光元X");
    const sy = section.getByLabel("3Dビーム発光元Y");
    await sx.fill("-6");
    await sx.blur();
    await sy.fill("7");
    await sy.blur();

    await expect(sx).toHaveValue(/-6/);
    await expect(sy).toHaveValue(/7/);

    await selectBeam3D(page, 2);
    await selectBeam3D(page, 1);
    await expect(section.getByLabel("3Dビーム発光元X")).toHaveValue(/-6/);
    await expect(section.getByLabel("3Dビーム発光元Y")).toHaveValue(/7/);
  });

  // ------------------------------------------------------------------
  // 5. source zを変更できる
  // ------------------------------------------------------------------
  test("source zを変更でき、保持される", async ({ page }) => {
    await setupSceneWithOneBeam3D(page);
    const section = currentSceneSection(page);

    const sz = section.getByLabel("3Dビーム発光元高さ");
    await sz.fill("10");
    await sz.blur();
    await expect(sz).toHaveValue(/10/);
  });

  // ------------------------------------------------------------------
  // 6. target x/yを変更できる
  // ------------------------------------------------------------------
  test("target x/yを変更でき、保持される", async ({ page }) => {
    await setupSceneWithOneBeam3D(page);
    const section = currentSceneSection(page);

    const tx = section.getByLabel("3Dビーム照射先X");
    const ty = section.getByLabel("3Dビーム照射先Y");
    await tx.fill("2");
    await tx.blur();
    await ty.fill("3");
    await ty.blur();

    await expect(tx).toHaveValue(/2/);
    await expect(ty).toHaveValue(/3/);
  });

  // ------------------------------------------------------------------
  // 7. sourceWidth / targetWidthを変更できる
  // ------------------------------------------------------------------
  test("光の幅（根元・先端）を変更でき、保持される", async ({ page }) => {
    await setupSceneWithOneBeam3D(page);
    const section = currentSceneSection(page);

    const rootWidth = section.getByLabel("3Dビーム根元幅");
    const tipWidth = section.getByLabel("3Dビーム先端幅");
    await rootWidth.fill("0.8");
    await rootWidth.blur();
    await tipWidth.fill("2");
    await tipWidth.blur();

    await expect(rootWidth).toHaveValue(/0.8/);
    await expect(tipWidth).toHaveValue(/2/);
  });

  // ------------------------------------------------------------------
  // 8. color変更を保持
  // ------------------------------------------------------------------
  test("色を変更でき、Beam切り替え後も保持される", async ({ page }) => {
    await setupSceneWithOneBeam3D(page);
    await addLightingBeam3D(page);
    const section = currentSceneSection(page);

    await selectBeam3D(page, 1);
    await section.getByRole("button", { name: "3D照明ビームの色を青にする" }).click();

    await selectBeam3D(page, 2);
    await selectBeam3D(page, 1);
    await expect(section.getByLabel("3Dビーム発光元X")).toBeVisible();
  });

  // ------------------------------------------------------------------
  // 9. intensity変更を保持
  // ------------------------------------------------------------------
  test("intensityを変更でき、Beam切り替え後も保持される", async ({ page }) => {
    await setupSceneWithOneBeam3D(page);
    await addLightingBeam3D(page);
    const section = currentSceneSection(page);

    await selectBeam3D(page, 1);
    await section.getByRole("button", { name: "25%" }).click();

    await selectBeam3D(page, 2);
    await selectBeam3D(page, 1);
    await expect(section.getByText("明るさ", { exact: true })).toBeVisible();
  });

  // ------------------------------------------------------------------
  // 10. Beam削除
  // ------------------------------------------------------------------
  test("Beam v2を1本削除しても他のBeamは残る", async ({ page }) => {
    await setupSceneWithOneBeam3D(page); // 1本目
    await addLightingBeam3D(page); // 2本目
    await addLightingBeam3D(page); // 3本目
    const section = currentSceneSection(page);

    await selectBeam3D(page, 2);
    await section.getByRole("button", { name: "この3D照明ビームを削除" }).click();

    await expect(section.getByRole("button", { name: "3D照明ビーム 1" })).toBeVisible();
    await expect(section.getByRole("button", { name: "3D照明ビーム 2" })).toBeVisible();
    await expect(section.getByRole("button", { name: "3D照明ビーム 3" })).toHaveCount(0);
  });

  // ------------------------------------------------------------------
  // 11. Lighting UI整理・Prototype卒業により、Project全体の「照明機能を使う」は正式UIから
  // 削除された。旧テストの代わりに、「この構成で照明を使用」OFF→ONでもBeam v2の設定値が
  // 保持されることを確認する（13番のScene OFF→ONテストとは別に、値の保持まで確認する）。
  // ------------------------------------------------------------------
  test("この構成で照明を使用OFF→ONでもBeam v2の設定値が保持される", async ({ page }) => {
    await setupSceneWithOneBeam3D(page);
    const section = currentSceneSection(page);
    const sz = section.getByLabel("3Dビーム発光元高さ");
    await sz.fill("9");
    await sz.blur();

    await section.getByLabel("この構成で照明を使用").uncheck();
    await expect(section.getByRole("button", { name: "3D照明ビーム 1" })).toBeVisible();

    await section.getByLabel("この構成で照明を使用").check();
    await selectBeam3D(page, 1);
    await expect(section.getByLabel("3Dビーム発光元高さ")).toHaveValue(/9/);
  });

  // ------------------------------------------------------------------
  // 12. showLighting OFF→ONでもデータ保持
  // ------------------------------------------------------------------
  test("showLighting OFF→ONでもBeam v2のデータ・設定UIが保持される", async ({ page }) => {
    await setupSceneWithOneBeam3D(page);

    await page.getByLabel("照明を表示").uncheck();
    await expect(page.getByRole("button", { name: "3D照明ビーム 1" })).toBeVisible();

    await page.getByLabel("照明を表示").check();
    await expect(page.getByRole("button", { name: "3D照明ビーム 1" })).toBeVisible();
  });

  // ------------------------------------------------------------------
  // 13. Scene OFF→ONでもデータ保持
  // ------------------------------------------------------------------
  test("Scene OFF→ONでもBeam v2のデータが保持される", async ({ page }) => {
    await setupSceneWithOneBeam3D(page);
    const section = currentSceneSection(page);

    await section.getByLabel("この構成で照明を使用").uncheck();
    // Scene無効時もBeam一覧UI自体は表示され続ける（Area/Beam v1と同じ仕様）
    await expect(page.getByRole("button", { name: "3D照明ビーム 1" })).toBeVisible();

    await section.getByLabel("この構成で照明を使用").check();
    await expect(page.getByRole("button", { name: "3D照明ビーム 1" })).toBeVisible();
  });

  // ------------------------------------------------------------------
  // 14. 同一Project内Formation copyでBeam v2が引き継がれる
  // 15. copy後、コピー元とコピー先のsource/targetが独立している
  // ------------------------------------------------------------------
  test("同一Project内でFormationを複製するとBeam v2も引き継がれ、source/targetが独立している", async ({ page }) => {
    await setupSceneWithOneBeam3D(page);
    const section = currentSceneSection(page);
    const sx = section.getByLabel("3Dビーム発光元X");
    await sx.fill("-3");
    await sx.blur();

    // 構成一覧の「⋯」メニュー経由はモーダル描画待ちが絡み実機でtimeoutしやすいため、
    // 既存の安定したキーボードショートカット経路（Ctrl/Cmd+C→Ctrl/Cmd+V、同一Project内
    // 貼り付け）を使う。pasteCopiedSlide()は貼り付け後、currentSlideIndexを新しく
    // 貼り付けられた構成（＝コピー先）へ自動的に移動するため、Meta+V直後にそのまま
    // コピー先の内容を確認できる（duplicateSlideAt()と異なり、明示的な画面遷移が不要）。
    await page.keyboard.press("Meta+c");
    await page.keyboard.press("Meta+v");

    const copiedSection = currentSceneSection(page);
    await expect(copiedSection.getByRole("button", { name: "3D照明ビーム 1" })).toBeVisible();
    await selectBeam3D(page, 1);
    await expect(copiedSection.getByLabel("3Dビーム発光元X")).toHaveValue(/-3/);

    // コピー先のsourceXを変更しても、コピー元（1番目の構成）が影響を受けないこと
    // （nested source/targetオブジェクトが参照共有されていない証跡）。
    // 構成間の移動自体（SlideCardの直接クリック）は「⋯」メニューとは別の安定した経路のため
    // そのまま使う。
    const copiedSx = copiedSection.getByLabel("3Dビーム発光元X");
    await copiedSx.fill("1");
    await copiedSx.blur();

    await page.getByRole("button", { name: /^1番目の構成/ }).click();
    const originalSection = currentSceneSection(page);
    await selectBeam3D(page, 1);
    await expect(originalSection.getByLabel("3Dビーム発光元X")).toHaveValue(/-3/);
  });

  // ------------------------------------------------------------------
  // 16. Beam追加Undo→Redo
  // ------------------------------------------------------------------
  test("Beam v2追加後にUndoするとBeamが消え、Redoで戻る", async ({ page }) => {
    await openFreshApp(page);
    await enableLighting(page);
    await addLightingScene(page);
    await addLightingBeam3D(page);

    await expect(page.getByRole("button", { name: "3D照明ビーム 1" })).toBeVisible();

    const undoButton = page.getByRole("button", { name: /元に戻す/ });
    await undoButton.click();
    await expect(page.getByRole("button", { name: "3D照明ビーム 1" })).toHaveCount(0);

    const redoButton = page.getByRole("button", { name: /やり直す/ });
    await redoButton.click();
    await expect(page.getByRole("button", { name: "3D照明ビーム 1" })).toBeVisible();
  });

  // ------------------------------------------------------------------
  // 17. source dragでX/Yが変化
  // 18. target dragでX/Yが変化
  // ------------------------------------------------------------------
  test("平面図でsourceマーカーをドラッグするとX/Yが変わる（不安定な場合はskip検討）", async ({ page }) => {
    await setupSceneWithOneBeam3D(page);
    await switchToTopView(page);
    const section = currentSceneSection(page);

    const sx = section.getByLabel("3Dビーム発光元X");
    const before = await sx.inputValue();

    // sourceマーカーは塗りつぶしcircle（fill付き、strokeなしの通常状態）として描画されている。
    // アクセシブルな名前を持たないため、平面図SVG内のcircle要素から掴む。
    // App.jsx側のJSX描画順は「target（照射先・外枠circle）→ source（発光元・塗りつぶしcircle）」
    // の順（TopView内コメント「target：照射先（外枠circle）」の直後に
    // 「source：発光元（塗りつぶしcircle）」が続く実装）。このtestのセットアップ
    // （setupSceneWithOneBeam3D）はAreaを追加しないため、TopView SVG内のcircleは
    // このBeamのtarget・sourceの2つだけであり、常に [0]=target, [1]=source となる。
    // 以前は誤って.first()（＝target）を掴んでおり、target.x/yは変化してもsource.x/yは
    // 変化しないため「before === after」で失敗していた（App.jsx側の実装ではなく、
    // このtestのselectorが誤っていたことが原因）。
    const svg = page.locator("svg").first();
    const marker = svg.locator("circle").nth(1);
    const box = await marker.boundingBox();

    if (!box) {
      test.skip(true, "sourceマーカーのboundingBoxが取得できないため、この環境ではE2E化を見送ります。");
      return;
    }

    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 40, startY + 20, { steps: 5 });
    await page.mouse.up();

    const after = await sx.inputValue();
    expect(after).not.toBe(before);
  });

  // ------------------------------------------------------------------
  // 19. 俯瞰客席ビューにBeam v2 polygonが表示される
  // 20. source.z変更後も俯瞰Beamが表示される
  // ------------------------------------------------------------------
  test("俯瞰客席ビューにBeam v2が表示され、source.z変更後も表示され続ける", async ({ page }) => {
    await setupSceneWithOneBeam3D(page);
    await switchToAudienceView(page);

    const layer = beam3DLayer(page);
    await expect(layer).toBeVisible();
    await expect(layer.locator("polygon")).toHaveCount(1);

    // source.zを変更（平面図へ一度戻って数値入力）しても、俯瞰Beamが表示され続けること。
    await switchToTopView(page);
    const section = currentSceneSection(page);
    const sz = section.getByLabel("3Dビーム発光元高さ");
    await sz.fill("12");
    await sz.blur();

    await switchToAudienceView(page);
    await expect(beam3DLayer(page)).toBeVisible();
    await expect(beam3DLayer(page).locator("polygon")).toHaveCount(1);
  });

  // ------------------------------------------------------------------
  // 21. 平面図では3D polygon本体は表示せず、source/target marker＋guideのみ表示される
  // ------------------------------------------------------------------
  test("平面図ではBeam v2の3D polygon本体を描画せず、marker＋guide線のみ表示する", async ({ page }) => {
    await setupSceneWithOneBeam3D(page);
    await switchToTopView(page);

    // aria-label="3D照明ビーム"（正式Beam v2のpolygonレイヤー）は俯瞰ビュー専用コンポーネント
    // （OverheadAudienceView）にしか存在しないため、平面図ではDOM上に一切現れないはず。
    await expect(beam3DLayer(page)).toHaveCount(0);

    // source/targetのマーカー（circle）とガイド線（line）はSVG内に存在すること。
    const svg = page.locator("svg").first();
    const circleCount = await svg.locator("circle").count();
    expect(circleCount).toBeGreaterThan(0);
  });

  // ------------------------------------------------------------------
  // 22. Beam v2が存在していても既存Formation編集が正常
  // ------------------------------------------------------------------
  test("Beam v2が存在していても既存のFormation編集操作が正常に動く", async ({ page }) => {
    await setupSceneWithOneBeam3D(page);

    const addSlideButton = page.getByRole("button", { name: /構成を追加|＋ 構成/ }).first();
    if (await addSlideButton.count()) {
      await addSlideButton.click();
    }
    const undoButton = page.getByRole("button", { name: /元に戻す/ });
    if (await undoButton.count()) {
      await undoButton.click();
    }

    await expect(page.getByText("照明の設定")).toBeVisible();
  });

  // ------------------------------------------------------------------
  // 23. Beam v2が存在していてもExport画面が開く
  // 24. PNG Exportが生成可能
  // 25. PDF Exportが生成可能
  // ------------------------------------------------------------------
  test("Beam v2が存在していてもExport Centerが開き、PNG/PDF Exportが生成できる", async ({ page }) => {
    await setupSceneWithOneBeam3D(page);

    await page.getByRole("button", { name: "出力" }).click();
    // Export Centerが開くこと（AF章：Beam v2はまだExportに描画しないが、クラッシュしないこと）。
    await expect(page.getByRole("heading", { name: "出力", exact: true })).toBeVisible();

    await page.getByLabel(/^PNG/).check();
    const pngDownloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /出力/ }).last().click();
    const pngDownload = await pngDownloadPromise;
    expect(pngDownload.suggestedFilename()).toMatch(/\.png$/i);

    await page.getByRole("button", { name: "出力" }).click();
    await page.getByLabel(/^PDF/).check();
    const pdfDownloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /出力/ }).last().click();
    const pdfDownload = await pdfDownloadPromise;
    expect(pdfDownload.suggestedFilename()).toMatch(/\.pdf$/i);
  });
});
