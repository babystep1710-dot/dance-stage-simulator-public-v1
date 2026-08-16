import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");

  // 各テストを独立した新規Project状態で行う。
  await page.evaluate(() => {
    localStorage.clear();
  });

  await page.reload();
  await page.waitForLoadState("networkidle");
});

const lightingProjectToggle = (page) =>
  page.getByLabel("照明機能を使う", { exact: true });

const lightingDisplayToggle = (page) =>
  page.getByLabel("舞台上に照明表示を出す", { exact: true });

async function enableLighting(page) {
  const toggle = lightingProjectToggle(page);
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
}

async function addCurrentLightingScene(page) {
  const addButton = page.getByRole("button", {
    name: "＋ この構成に照明設定を追加",
  });

  await expect(addButton).toBeVisible();
  await addButton.click();

  await expect(
    page.getByLabel("この構成の照明を有効にする")
  ).toBeVisible();
}

test("Lightingは初期状態でOFF", async ({ page }) => {
  const toggle = lightingProjectToggle(page);

  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();

  // Lighting OFFでは構成ごとのLighting UIは表示しない。
  await expect(
    page.getByText("この構成の照明", { exact: true })
  ).toHaveCount(0);

  await expect(lightingDisplayToggle(page)).toHaveCount(0);
});

test("LightingをONにすると表示切替とScene追加入口が現れる", async ({
  page,
}) => {
  await enableLighting(page);

  await expect(lightingDisplayToggle(page)).toBeVisible();
  await expect(lightingDisplayToggle(page)).toBeChecked();

  await expect(
    page.getByRole("button", {
      name: "＋ この構成に照明設定を追加",
    })
  ).toBeVisible();
});

test("Lighting Sceneを追加してON/OFFできる", async ({ page }) => {
  await enableLighting(page);
  await addCurrentLightingScene(page);

  const sceneToggle = page.getByLabel("この構成の照明を有効にする");

  await expect(sceneToggle).toBeChecked();

  await sceneToggle.uncheck();
  await expect(sceneToggle).not.toBeChecked();

  await sceneToggle.check();
  await expect(sceneToggle).toBeChecked();
});

test("Lighting Sceneメモを保存できる", async ({ page }) => {
  await enableLighting(page);
  await addCurrentLightingScene(page);

  const memo = page.getByPlaceholder(
    "例：中央を強調／後方待機は見せたくない／次の構成に向けて徐々に暗く"
  );

  await expect(memo).toBeVisible();

  await memo.fill("中央の出演者を強調。後方待機は見せない。");
  await memo.blur();

  await expect(memo).toHaveValue(
    "中央の出演者を強調。後方待機は見せない。"
  );

  // WorkspaceのlocalStorage保存は300ms debounceなので、
  // 保存完了を確認してからreloadする。
  await expect(page.getByText("保存済み", { exact: true })).toBeVisible();

  // 「保存済み」が初期状態から表示されている可能性もあるため、
  // debounce時間を十分に超えるまで待って永続化完了を保証する。
  await page.waitForTimeout(450);

  // 再読み込みしても作品データとして残っていることを確認。
  await page.reload();
  await page.waitForLoadState("networkidle");

  await expect(
    page.getByPlaceholder(
      "例：中央を強調／後方待機は見せたくない／次の構成に向けて徐々に暗く"
    )
  ).toHaveValue("中央の出演者を強調。後方待機は見せない。");
});

test("Lighting Sceneを削除できる", async ({ page }) => {
  await enableLighting(page);
  await addCurrentLightingScene(page);

  await page.getByRole("button", {
    name: "この構成の照明設定を削除",
  }).click();

  await expect(
    page.getByRole("button", {
      name: "＋ この構成に照明設定を追加",
    })
  ).toBeVisible();

  await expect(
    page.getByRole("button", {
      name: "この構成の照明設定を削除",
    })
  ).toHaveCount(0);
});

test("同一Projectで構成を複製するとLighting Sceneも引き継がれる", async ({
  page,
}) => {
  await enableLighting(page);
  await addCurrentLightingScene(page);

  const memo = page.getByPlaceholder(
    "例：中央を強調／後方待機は見せたくない／次の構成に向けて徐々に暗く"
  );

  await memo.fill("コピー確認用Lighting");
  await memo.blur();

  // 現在構成を複製。
  // 構成一覧側に複数の「複製」系UIがある可能性を避け、
  // キーボードコピー＆ペーストを利用する。
  await page.keyboard.press("Meta+c");
  await page.keyboard.press("Meta+v");

  // 貼り付け後は新しい構成へ移る既存仕様を利用。
  await expect(
    page.getByPlaceholder(
      "例：中央を強調／後方待機は見せたくない／次の構成に向けて徐々に暗く"
    )
  ).toHaveValue("コピー確認用Lighting");
});

test("Formation削除後もLighting UIが正常に扱える", async ({ page }) => {
  await enableLighting(page);
  await addCurrentLightingScene(page);

  // まず構成をもう1つ作り、削除可能な状態にする。
  await page.getByRole("button", {
    name: "新しい構成を追加",
  }).click();

  await expect(
    page.locator('[data-slide-index="1"]')
  ).toBeVisible();

  // 新しい構成にはSceneがない。
  await expect(
    page.getByRole("button", {
      name: "＋ この構成に照明設定を追加",
    })
  ).toBeVisible();

  // Undoで新しい構成を消す。
  // これによってslides変更後もLighting Scene参照が壊れないことを確認する。
  const undoButton = page.getByTitle(/元に戻す/);
  await undoButton.click();

  await expect(
    page.locator('[data-slide-index="1"]')
  ).toHaveCount(0);

  // 元構成のSceneへ正常に戻れる。
  await expect(
    page.getByLabel("この構成の照明を有効にする")
  ).toBeVisible();
});

test("Lighting OFFでも従来のFormation編集を使える", async ({ page }) => {
  await expect(lightingProjectToggle(page)).not.toBeChecked();

  await page.getByRole("button", {
    name: "＋ 出演者を追加",
  }).click();

  await expect(
    page.getByText(/出演者一覧（1 \/ 100人）/)
  ).toBeVisible();

  await page.getByRole("button", {
    name: "新しい構成を追加",
  }).click();

  await expect(
    page.locator('[data-slide-index="1"]')
  ).toBeVisible();

  // Lightingは依然OFF。
  await expect(lightingProjectToggle(page)).not.toBeChecked();
});

test("舞台の外観設定が表示される", async ({ page }) => {
  await expect(
    page.getByText("舞台の外観", { exact: true })
  ).toBeVisible();

  await expect(
    page.getByText("床の色", { exact: true })
  ).toBeVisible();

  await expect(
    page.getByText("壁・背景の色", { exact: true })
  ).toBeVisible();
});
