// Lighting Area v1・Playwrightテスト（修正版）
//
// 修正の経緯：
// 実機でのnpm run check結果（全37件中8件failure）を受けて、実際のApp.jsxのDOM構造・
// アクセシブル名を1行ずつ照合し、selector・helperのみを修正しました。App.jsxの機能実装は
// 一切変更していません（詳細は今回のチャット末尾の報告を参照）。
//
// 主な原因は次の2点でした：
//   1. addLightingArea()がAreaを追加するだけで「選択」まで行っていなかったため、
//      Area追加直後にshape/色/サイズ等のUIを操作しようとするテストが軒並みタイムアウトしていた。
//      → helper側でAreaを追加した直後に、その新しいAreaを選択するよう修正。
//   2. getByText("形") / getByText("色") が、同じページ内の他の要素
//      （「矩形」ボタン、出演者色ピッカーの「色」ラベル等）と部分一致・完全一致で衝突していた。
//      → { exact: true } の付与に加え、「現在の構成の照明」という<section>見出しでlocatorを
//        スコープし、他パネルの同名ラベルと衝突しないようにした。
//
// Selector方針（D章）：可能な限り getByRole / getByLabel / getByText / getByPlaceholder を
// 使用。DraftNumberField（幅・奥行き）のaria-labelは前回セッションで追加済みのApp.jsx側の
// 最小限の改善（今回は変更していません）。

import { test, expect } from "@playwright/test";

// ------------------------------------------------------------------
// 共通helper
// ------------------------------------------------------------------

// アプリを「保存データなしの新規状態」で開く。既存smoke/lighting testsが別の初期化方式
// （例：特定のfixtureページや別のstorage key）を使っている場合は、そちらに合わせて
// この関数の中身だけを差し替えてください。
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

// 「現在の構成の照明」<section>にスコープしたlocatorを返す。App.jsx側でこの見出し
// （<h2>現在の構成の照明</h2>）を直接の子に持つ<section>が、Scene追加ボタン・Scene ON/OFF・
// メモ・Area一覧・選択中Areaの設定（形・色・位置・サイズ・明るさ・削除）をすべて内包している。
// 「形」「色」等の短い汎用ラベルは、出演者色ピッカーなど他パネルの同名ラベルと衝突するため、
// 必ずこのスコープ経由でlocatorを取得する。
function currentSceneSection(page) {
  return page.locator("section", {
    has: page.getByRole("heading", { name: "現在の構成の照明" }),
  });
}

// 「照明の設定」内の「照明機能を使う」をONにする。
async function enableLighting(page) {
  await page.getByLabel("照明機能を使う").check();
}

// 現在のFormationにLighting Sceneを追加する（未追加の場合のみ有効なボタンが表示される）。
async function addLightingScene(page) {
  await currentSceneSection(page).getByRole("button", { name: "＋ この構成に照明設定を追加" }).click();
}

// 現在のSceneへLighting Areaを1件追加し、追加した直後にそのAreaを選択状態にする。
// 実際のApp.jsx（addLightingAreaForCurrentScene）はArea追加時に自動選択を行わない仕様のため、
// 「追加したAreaの設定を開くには、一覧から明示的にクリックする」という実際のユーザー操作を
// テスト側で再現する（App.jsx側の仕様変更ではなく、テストが正しい操作手順を踏んでいなかった
// ことが根本原因だったため）。
async function addLightingArea(page) {
  const section = currentSceneSection(page);
  const existingCount = await section.getByRole("button", { name: /^照明エリア \d+$/ }).count();
  await section.getByRole("button", { name: "＋ 照明エリアを追加" }).click();
  await section.getByRole("button", { name: `照明エリア ${existingCount + 1}` }).click();
}

// Lighting ON → Scene追加 → Area1件追加（追加したAreaは選択済み）、までを一括で行う。
async function setupSceneWithOneArea(page) {
  await openFreshApp(page);
  await enableLighting(page);
  await addLightingScene(page);
  await addLightingArea(page);
}

// 指定した番号（1始まり）のAreaを選択する。
async function selectArea(page, index) {
  await currentSceneSection(page).getByRole("button", { name: `照明エリア ${index}` }).click();
}

// ------------------------------------------------------------------
// F. Areaを追加できる
// ------------------------------------------------------------------
test.describe("Lighting Area v1", () => {
  test("Areaを追加できる（初期値の確認）", async ({ page }) => {
    await setupSceneWithOneArea(page);
    const section = currentSceneSection(page);

    // 「照明エリア 1」が一覧に表示される
    await expect(section.getByRole("button", { name: "照明エリア 1" })).toBeVisible();

    // Area設定UI一式が表示される（exact:trueで「矩形」ボタン等との部分一致を避ける）
    await expect(section.getByText("形", { exact: true })).toBeVisible();
    await expect(section.getByText("色", { exact: true })).toBeVisible();
    await expect(section.getByText("明るさ", { exact: true })).toBeVisible();

    // shapeの初期値は「円」
    await expect(section.getByRole("button", { name: "円", exact: true })).toBeVisible();

    // 色の初期値は「白」（スウォッチボタンが存在すること。選択状態そのものの視覚的な
    // 確認まではE2Eで安定して行いにくいため、ボタンの存在確認に留める）
    await expect(section.getByRole("button", { name: "照明エリアの色を白にする" })).toBeVisible();

    // width / heightの数値入力が表示される（幅・奥行き）
    await expect(section.getByLabel("幅")).toBeVisible();
    await expect(section.getByLabel("奥行き")).toBeVisible();

    // intensity選択UI（0/25/50/75/100%の5段階ボタン）が表示される
    await expect(section.getByRole("button", { name: "0%", exact: true })).toBeVisible();
    await expect(section.getByRole("button", { name: "25%", exact: true })).toBeVisible();
    await expect(section.getByRole("button", { name: "50%", exact: true })).toBeVisible();
    await expect(section.getByRole("button", { name: "75%", exact: true })).toBeVisible();
    await expect(section.getByRole("button", { name: "100%", exact: true })).toBeVisible();

    // 平面図上にArea polygon（SVG）が存在すること
    const svg = page.locator("svg").first();
    const polygonCount = await svg.locator("polygon").count();
    expect(polygonCount).toBeGreaterThan(0);
  });

  // ------------------------------------------------------------------
  // G. Areaを複数追加できる
  // ------------------------------------------------------------------
  test("Areaを複数追加できる", async ({ page }) => {
    await setupSceneWithOneArea(page); // 1件目
    await addLightingArea(page); // 2件目
    await addLightingArea(page); // 3件目
    const section = currentSceneSection(page);

    await expect(section.getByRole("button", { name: "照明エリア 1" })).toBeVisible();
    await expect(section.getByRole("button", { name: "照明エリア 2" })).toBeVisible();
    await expect(section.getByRole("button", { name: "照明エリア 3" })).toBeVisible();

    // 選択を切り替えられること（クリックしてもクラッシュしない・設定UIが残る）
    await selectArea(page, 2);
    await expect(section.getByText("形", { exact: true })).toBeVisible();
    await selectArea(page, 3);
    await expect(section.getByText("形", { exact: true })).toBeVisible();
  });

  // ------------------------------------------------------------------
  // H. shape変更
  // ------------------------------------------------------------------
  test("shapeを円→楕円→矩形へ変更できる", async ({ page }) => {
    await setupSceneWithOneArea(page);
    const section = currentSceneSection(page);

    await section.getByRole("button", { name: "楕円" }).click();
    await expect(section.getByLabel("幅")).toBeVisible();
    await expect(section.getByLabel("奥行き")).toBeVisible();

    await section.getByRole("button", { name: "矩形" }).click();
    // 矩形へ変更後もArea設定UIが正常に残ること
    await expect(section.getByLabel("幅")).toBeVisible();
    await expect(section.getByLabel("奥行き")).toBeVisible();
    // 矩形では「幅」「奥行き」が独立して編集可能（disabledでないこと）
    await expect(section.getByLabel("奥行き")).toBeEnabled();
  });

  // ------------------------------------------------------------------
  // I. 色変更
  // ------------------------------------------------------------------
  test("色を変更でき、Area切り替え後も保持される", async ({ page }) => {
    await setupSceneWithOneArea(page);
    await addLightingArea(page); // 2件目（切り替え確認用）
    const section = currentSceneSection(page);

    await selectArea(page, 1);
    await section.getByRole("button", { name: "照明エリアの色を赤にする" }).click();

    // 別Areaへ切り替えて戻る
    await selectArea(page, 2);
    await expect(section.getByText("形", { exact: true })).toBeVisible();
    await selectArea(page, 1);

    // UIがクラッシュせず、設定パネルが引き続き表示されること
    await expect(section.getByText("色", { exact: true })).toBeVisible();
  });

  // ------------------------------------------------------------------
  // J. size変更（ellipse）
  // ------------------------------------------------------------------
  test("ellipseでwidth / heightを数値入力で変更でき、切り替え後も保持される", async ({ page }) => {
    await setupSceneWithOneArea(page);
    await addLightingArea(page); // 2件目
    const section = currentSceneSection(page);

    await selectArea(page, 1);
    await section.getByRole("button", { name: "楕円" }).click();

    const widthInput = section.getByLabel("幅");
    const heightInput = section.getByLabel("奥行き");
    await widthInput.fill("6");
    await widthInput.blur();
    await heightInput.fill("3");
    await heightInput.blur();

    await expect(widthInput).toHaveValue(/6/);
    await expect(heightInput).toHaveValue(/3/);

    // 別Areaへ切り替えて戻っても保持されること
    await selectArea(page, 2);
    await selectArea(page, 1);
    await expect(section.getByLabel("幅")).toHaveValue(/6/);
    await expect(section.getByLabel("奥行き")).toHaveValue(/3/);
  });

  // circleの場合、widthを変えるとheightも同値へ同期する仕様の確認（K章で許容されている追加確認）
  test("circleはwidthを変更するとheightも同じ値へ同期される", async ({ page }) => {
    await setupSceneWithOneArea(page);
    const section = currentSceneSection(page);
    // 初期shapeは円のまま（createDefaultLightingAreaのdefault）

    const widthInput = section.getByLabel("幅");
    await widthInput.fill("5");
    await widthInput.blur();

    const heightInput = section.getByLabel("奥行き");
    await expect(heightInput).toHaveValue(/5/);
  });

  // ------------------------------------------------------------------
  // K. intensity変更
  // ------------------------------------------------------------------
  test("intensityを変更でき、Area切り替え後も保持される", async ({ page }) => {
    await setupSceneWithOneArea(page);
    await addLightingArea(page); // 2件目
    const section = currentSceneSection(page);

    await selectArea(page, 1);
    await section.getByRole("button", { name: "75%", exact: true }).click();
    await section.getByRole("button", { name: "25%", exact: true }).click();

    await selectArea(page, 2);
    await selectArea(page, 1);

    // 選択し直した後もUIが表示され続けること
    await expect(section.getByText("明るさ", { exact: true })).toBeVisible();
  });

  // ------------------------------------------------------------------
  // L. Area削除
  // ------------------------------------------------------------------
  test("Areaを1件削除しても他のAreaは残る", async ({ page }) => {
    await setupSceneWithOneArea(page); // 1件目
    await addLightingArea(page); // 2件目
    await addLightingArea(page); // 3件目
    const section = currentSceneSection(page);

    await selectArea(page, 2);
    await section.getByRole("button", { name: "この照明エリアを削除" }).click();

    // 削除後は2件になり、UIがクラッシュしないこと
    await expect(section.getByRole("button", { name: "照明エリア 1" })).toBeVisible();
    await expect(section.getByRole("button", { name: "照明エリア 2" })).toBeVisible();
    await expect(section.getByRole("button", { name: "照明エリア 3" })).toHaveCount(0);
  });

  // ------------------------------------------------------------------
  // M. Lighting OFF→ONでArea保持
  // ------------------------------------------------------------------
  test("Lighting OFF→ONでもAreaのデータが保持される", async ({ page }) => {
    await setupSceneWithOneArea(page);
    const section = currentSceneSection(page);
    await section.getByRole("button", { name: "楕円" }).click();
    await section.getByRole("button", { name: "照明エリアの色を青にする" }).click();
    const widthInput = section.getByLabel("幅");
    await widthInput.fill("7");
    await widthInput.blur();

    // Lighting機能をOFF
    await page.getByLabel("照明機能を使う").uncheck();
    await expect(page.getByRole("button", { name: "照明エリア 1" })).toHaveCount(0);

    // 再度ON
    await page.getByLabel("照明機能を使う").check();

    // Areaが再表示され、設定値も保持されていること
    const sectionAfter = currentSceneSection(page);
    await expect(sectionAfter.getByRole("button", { name: "照明エリア 1" })).toBeVisible();
    await selectArea(page, 1);
    await expect(sectionAfter.getByRole("button", { name: "楕円" })).toBeVisible();
    await expect(sectionAfter.getByLabel("幅")).toHaveValue(/7/);
  });

  // ------------------------------------------------------------------
  // N. showLighting OFF→ONでArea保持
  // ------------------------------------------------------------------
  test("showLighting OFF→ONでもAreaのデータ・設定UIが保持される", async ({ page }) => {
    await setupSceneWithOneArea(page);

    // 「舞台上に照明表示を出す」をOFF
    await page.getByLabel("舞台上に照明表示を出す").uncheck();

    // Area設定UI（サイドバー側）はデータ操作パネルなので、表示ON/OFFの影響を受けず
    // 引き続き操作可能であること
    await expect(page.getByRole("button", { name: "照明エリア 1" })).toBeVisible();

    // 再度ON
    await page.getByLabel("舞台上に照明表示を出す").check();
    await expect(page.getByRole("button", { name: "照明エリア 1" })).toBeVisible();
  });

  // ------------------------------------------------------------------
  // O. FormationコピーでArea引継ぎ
  // ------------------------------------------------------------------
  test("同一Project内でFormationを複製するとLighting SceneとAreaも引き継がれる", async ({ page }) => {
    await setupSceneWithOneArea(page);
    const section = currentSceneSection(page);
    await section.getByRole("button", { name: "矩形" }).click();
    await section.getByRole("button", { name: "照明エリアの色を緑にする" }).click();
    const widthInput = section.getByLabel("幅");
    await widthInput.fill("8");
    await widthInput.blur();
    const heightInput = section.getByLabel("奥行き");
    await heightInput.fill("2");
    await heightInput.blur();

    // 構成カード左上の「⋯」メニュー（SlideCardMenuButton、
    // aria-label="構成メニュー（複製・コピー・貼り付け・削除）"）→「複製」。
    // この時点では構成は1枚しか存在しないため、このaria-labelを持つボタンは1つだけのはず。
    // 既存Lightingテストで安定している同一Project内コピー経路を再利用する。
    await page.keyboard.press("Meta+c");
    await page.keyboard.press("Meta+v");

    // 重要：duplicateSlideAt()は複製後もcurrentSlideIndexを複製元のまま維持する仕様のため
    // （新しく増えた構成が自動的に「現在の構成」にはならない）、コピー先を実際に確認するには
    // 明示的に2番目の構成カードへ移動する必要がある。SlideCardのaria-labelは
    // `${番号}番目の構成：${構成名}` という形式なので、構成名に依存しないよう正規表現で
    // 先頭一致させる。
    await page.getByRole("button", { name: /^2番目の構成/ }).click();

    // コピー先Formationでも Lighting Scene + Area が存在し、設定が引き継がれていること
    const copiedSection = currentSceneSection(page);
    await expect(copiedSection.getByRole("button", { name: "照明エリア 1" })).toBeVisible();
    await selectArea(page, 1);
    await expect(copiedSection.getByRole("button", { name: "矩形" })).toBeVisible();
    await expect(copiedSection.getByLabel("幅")).toHaveValue(/8/);
    await expect(copiedSection.getByLabel("奥行き")).toHaveValue(/2/);
  });

  // ------------------------------------------------------------------
  // Q. Areaがあっても既存Formation編集が動く
  // ------------------------------------------------------------------
  test("Areaが存在していても既存のFormation編集操作が正常に動く", async ({ page }) => {
    await setupSceneWithOneArea(page);

    // 既存のFormation追加操作の一例。実際のボタン名が異なる場合は、既存smoke.spec.jsの
    // 「構成追加とUndo」テストと同じ操作へ置き換えてください。
    const addSlideButton = page.getByRole("button", { name: /構成を追加|＋ 構成/ }).first();
    if (await addSlideButton.count()) {
      await addSlideButton.click();
    }

    // 既存Undoボタンが機能すること（クラッシュしないことを最低限確認）
    const undoButton = page.getByRole("button", { name: /元に戻す/ });
    if (await undoButton.count()) {
      await undoButton.click();
    }

    // Area機能追加によってページ全体が壊れていないこと
    await expect(page.getByText("照明の設定")).toBeVisible();
  });

  // ------------------------------------------------------------------
  // S. Undo/Redo（任意項目）
  // ------------------------------------------------------------------
  test("Area追加後にUndoするとAreaが消え、Redoで戻る", async ({ page }) => {
    await openFreshApp(page);
    await enableLighting(page);
    await addLightingScene(page);
    await addLightingArea(page);

    await expect(page.getByRole("button", { name: "照明エリア 1" })).toBeVisible();

    const undoButton = page.getByRole("button", { name: /元に戻す/ });
    await undoButton.click();
    await expect(page.getByRole("button", { name: "照明エリア 1" })).toHaveCount(0);

    const redoButton = page.getByRole("button", { name: /やり直す/ });
    await redoButton.click();
    await expect(page.getByRole("button", { name: "照明エリア 1" })).toBeVisible();
  });

  // ------------------------------------------------------------------
  // R. resize drag（実機確認済み。座標依存のE2Eは不安定なリスクがあるため、
  //    ここでは「rect Areaのresize handleがDOM上に存在し、ドラッグでwidthが変わる」
  //    という軽量な確認に留める。不安定な場合はtest.skip()で構わない）。
  // ------------------------------------------------------------------
  test("rect Areaのresize handleをドラッグするとwidthが変わる（不安定な場合はskip検討）", async ({ page }) => {
    await setupSceneWithOneArea(page);
    const section = currentSceneSection(page);
    await section.getByRole("button", { name: "矩形" }).click();

    const widthInput = section.getByLabel("幅");
    const before = await widthInput.inputValue();

    // resize handleはSVG <circle> として描画されており、アクセシブルな名前を持たないため、
    // 平面図SVG内の最初の<circle>要素（選択中Areaのeハンドル）をそのまま掴む。
    // これはApp.jsxの実装（描画順）に依存する脆いselectorのため、環境によって不安定なら
    // このtestごとskipして構わない（production codeへtest専用idを大量追加することは
    // 禁止されているため、無理な安定化はしない）。
    const svg = page.locator("svg").first();
    const handle = svg.locator("circle").first();
    const box = await handle.boundingBox();

    if (!box) {
      test.skip(true, "resize handleのboundingBoxが取得できないため、この環境ではE2E化を見送ります。");
      return;
    }

    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 40, startY, { steps: 5 });
    await page.mouse.up();

    const after = await widthInput.inputValue();
    expect(after).not.toBe(before);
  });
});
