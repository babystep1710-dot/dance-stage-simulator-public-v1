import React, { useState, useRef, useEffect, useMemo, useCallback, forwardRef, useImperativeHandle } from "react";
import JSZip from "jszip"; // Export Center v1.1・PART B：複数PNGを1つのZIPへまとめて一括ダウンロードするために追加。
// npm install jszip が必要（実行環境で `npm install jszip` を実行してください）。
import { PDFDocument } from "pdf-lib"; // Export Center v1.2：PDF出力のために追加。
// npm install pdf-lib が必要（実行環境で `npm install pdf-lib` を実行してください）。

/* =========================================================================
   舞台配置シミュレーター (第1段階: ステージ設定 + 出演者配置 + 待機エリア + 拡大縮小)
   -------------------------------------------------------------------------
   将来の拡張を見据えたデータ構造:
   - Performer   : 出演者そのものの基本情報（番号・色・身長など）
                   → スライドをまたいで共通の情報
   - Slide       : 1つの「構成」を表す。placements に出演者ごとの座標を持つ。
                   将来的に slides 配列を増やせば構成スライド機能になる。
   - Placement   : { x, y, area } のほか、将来は moveFrom / moveTo / waypoints /
                   startTime / endTime などを追加できるように
                   オブジェクトとして分離してある。
   - Lighting    : 今回は未実装だが、Slide とは別レイヤーとして
                   後から lights 配列・cues 配列を追加できるようにしてある。
   - ViewState   : ズーム倍率・表示位置（画面の見え方）。出演者の座標や
                   ステージ設定とは完全に分離して管理する（下記 viewState 参照）。
                   現在はビュー種別（topView / audienceView）ごとにアプリ全体で
                   共通の値を持つが、将来スライドごとに保存したくなった場合は
                   このオブジェクトを Slide の中に移すだけで済む形にしてある。
   ========================================================================= */

// ------------------------------------------------------------------
// 定数
// ------------------------------------------------------------------
const UNIT_CM = 90; // 1グリッド = 90cm
const WIDTH_MIN = 4;
const WIDTH_MAX = 40;
const DEPTH_MIN = 2;
const DEPTH_MAX = 30;
const MAX_PERFORMERS = 100;
// 身長設定 v2：UIでは「小・中・大」の3段階だけを表示する（PART I・J）。
// 内部値は引き続き単なる数値（cm相当）のまま保持し、"small"等の文字列型へは変更しない
// （PART U：既存のperformer.height schema・localStorage・Project Backupを壊さないため）。
const HEIGHT_PRESETS = [155, 170, 185]; // 小・中・大
const HEIGHT_PRESET_LABELS = { 155: "小", 170: "中", 185: "大" };
// 新規出演者のdefault height。旧150から中(170)へ変更（PART L）。addPerformer()・
// addPerformersBulk()の両方がこの1つの定数を参照することで、単体追加と一括追加の
// defaultがずれないようにする。
const DEFAULT_PERFORMER_HEIGHT = 170;

// 身長設定 v2・PART O：現在のheight（旧150/175を含む任意の数値）から、表示上もっとも近い
// preset（155/170/185）を判定するpure helper。表示のためだけに使い、この関数の戻り値で
// performer.heightそのものを書き換えることはしない（PART N：旧データはそのまま保持）。
function getHeightPreset(height) {
  if (typeof height !== "number" || !Number.isFinite(height)) return DEFAULT_PERFORMER_HEIGHT;
  let best = HEIGHT_PRESETS[0];
  let bestDiff = Math.abs(height - best);
  for (let i = 1; i < HEIGHT_PRESETS.length; i++) {
    const diff = Math.abs(height - HEIGHT_PRESETS[i]);
    if (diff < bestDiff) {
      best = HEIGHT_PRESETS[i];
      bestDiff = diff;
    }
  }
  return best;
}

// ------------------------------------------------------------------
// 構成間移動アニメーションの時間管理（カウント × BPM方式）
// ------------------------------------------------------------------
// ダンスの現場では時間を「秒」ではなく「カウント」（8カウント＝1エイト）で管理する。
// BPM（1分間の拍数）は「このプロジェクト／使用曲の時間軸を決める値」として
// work.project.bpm に保存する（詳細は App() 内の work.project 初期値・getProjectBpm() を参照）。
// DEFAULT_BPMは「新規プロジェクトの初期値」および「BPMを持たない古いデータへのfallback」
// としてのみ使い、実際の再生計算（countsToDurationMsの呼び出し）には常に
// getProjectBpm(work) の戻り値を渡す（DEFAULT_BPMを直接渡さない）。
const DEFAULT_BPM = 120; // 新規プロジェクトの初期値 / 旧データのfallback用
const MIN_BPM = 30; // BPMの許容下限（0や負数を防ぐ）
const MAX_BPM = 300; // BPMの許容上限
const DEFAULT_TRANSITION_COUNTS = 4; // 構成間の移動時間の初期値（4カウント＝0.5エイト、BPM120で2秒）
// 移動時間0count対応：MIN_KEEP_COUNTS（キープの最小値）が既に0まで許可しているのと同じ考え方で、
// 移動時間も「配置は変わらないが演出上は別の構成として管理したい」ケースのため0を正式な
// 有効値として扱う（1→0へ変更）。getTransitionCounts()のvalidity判定（v >= MIN_TRANSITION_COUNTS）・
// ＋／−ボタン・直接入力のclamp（Math.max(MIN_TRANSITION_COUNTS, ...)）は、この定数値を
// そのまま使っているため、ここを変えるだけで0が有効値として扱われるようになる。
const MIN_TRANSITION_COUNTS = 0; // 最低0カウント（配置替えなしで即座に次の構成へ切り替える演出用）
const COUNTS_PER_EIGHT = 8; // 1エイト＝8カウント（ダンスの基本単位）

// IME（日本語入力等）変換確定のEnterキーと、入力完了のEnterキーを区別するためのpure helper。
// event.nativeEvent.isComposing（本来のIME判定。ほとんどのモダンブラウザで信頼できる）に加え、
// 一部環境でisComposingが正しく取得できないケースへの保険として、IME変換確定時のEnterに
// 付与されるレガシーな値であるkeyCode===229も確認する。構成名入力欄（handleSlideNameKeyDown）
// で既に採用されていたこの2段判定を、他の「Enterで確定」入力欄（commitOnEnter・Project名欄等）
// でも共通で使えるようにpure helperとして切り出した（PART D・E：共通的に直す）。
function isImeComposingEvent(e) {
  return !!(e && e.nativeEvent && e.nativeEvent.isComposing) || !!(e && e.keyCode === 229);
}

// work.project.bpm を安全に取得するhelper。work.project自体が存在しない（BPM機能実装前の
// 古いデータ）場合や、project.bpmが数値でない場合は、DEFAULT_BPMへfallbackする。
// これにより、既存のslides/placementsを一切書き換えるmigration処理をしなくても、
// 古いデータを読み込んだ時点でクラッシュせずBPM120として動作する。
function getProjectBpm(work) {
  const bpm = work && work.project && work.project.bpm;
  return typeof bpm === "number" && Number.isFinite(bpm) ? bpm : DEFAULT_BPM;
}

// ------------------------------------------------------------------
// 出演者表示サイズ v1.2：平面図の出演者マーカー表示設定（配置座標・身長・poseとは無関係）
// ------------------------------------------------------------------
// work.project.performerDisplayScaleとして保存する、Project全体で1つだけの表示設定。
// 平面図の出演者マーカーサイズだけに役割を絞った設計（v1.1・PART D・E）を維持しつつ、
// v1.2では「大＝標準」「中＝やや小さめ」「小＝密集配置向け」という位置づけへ倍率を
// 再定義した（新しい「大」は旧バージョンの「中」相当のサイズ）。
// getProjectBpm(work)と全く同じ考え方の後方互換ヘルパーで、値が3段階のいずれでもない
// （＝未設定の既存Project・旧Backup）場合は「大」へfallbackする。
// PART C・migration：これまでのバージョンで保存された値（1.0／0.9／0.8／0.7／0.6等）は、
// 新しい配列[0.7, 0.8, 0.9]に数値として偶然一致するものだけそのまま新しい階層として
// 再解釈され、一致しないものは自動的に「大」へfallbackする。Projectが読み込めなくなる・
// 例外が発生することは無く、schema変更・migration専用コードも追加していない。
const PERFORMER_DISPLAY_SCALE_LARGE = 0.9;
const PERFORMER_DISPLAY_SCALE_MEDIUM = 0.8;
const PERFORMER_DISPLAY_SCALE_SMALL = 0.7;
const PERFORMER_DISPLAY_SCALES = [PERFORMER_DISPLAY_SCALE_SMALL, PERFORMER_DISPLAY_SCALE_MEDIUM, PERFORMER_DISPLAY_SCALE_LARGE];
function getPerformerDisplayScale(work) {
  const v = work && work.project && work.project.performerDisplayScale;
  return PERFORMER_DISPLAY_SCALES.includes(v) ? v : PERFORMER_DISPLAY_SCALE_LARGE;
}
// 出演者名は、丸・番号ほど極端に縮めない（読みやすさを優先＝PART D）。
// マーカーのdisplayScale（0.9/0.8/0.7）に対して、名前は1.00/0.95/0.90という緩やかな比率にする。
function getPerformerNameScale(displayScale) {
  if (displayScale === PERFORMER_DISPLAY_SCALE_SMALL) return 0.9;
  if (displayScale === PERFORMER_DISPLAY_SCALE_MEDIUM) return 0.95;
  return 1;
}

// BPM値を許容範囲（MIN_BPM〜MAX_BPM）へ収める。小数BPM（将来の音源解析・手動修正用）にも
// 対応できるよう、整数への丸めは行わずNumberのまま扱う。
function clampBpm(bpm) {
  const n = Number(bpm);
  if (!Number.isFinite(n)) return DEFAULT_BPM;
  return clamp(n, MIN_BPM, MAX_BPM);
}

// 「キープ」：構成そのものが持つ属性で、「その構成のまま何カウント維持するか」を表す
// （構成と構成の「間」の属性である transitionCounts とは明確に別物）。
// keepCounts + transitionCounts を交互につなげることで、連続再生（keep→move→keep→move…）の
// 時間軸を構成する（下記「構成間の連続再生」セクション参照）。
// 基本運用は「通常はキープなし・必要な構成だけキープを追加する」という考え方のため、
// 初期値は0（＝キープせずすぐ次の移動へ入る）にしてある。
// 重要：これは「新規に作られるslide」「明示的なkeepCountsを持たない古いslide」向けの
// 初期値／フォールバックであり、既にslideへ保存済みの値（8や4など）を書き換えるものではない
// （getKeepCounts()は「保存されている値があればそれを最優先」し、無い場合だけこの値を使う）。
const DEFAULT_KEEP_COUNTS = 0; // キープの初期値（0カウント＝キープなし、すぐ次の移動へ）
const MIN_KEEP_COUNTS = 0; // キープは「すぐ次の移動へ入る」ケースを許容するため0まで許可する

// カウント数とBPMから、アニメーションの再生時間（ミリ秒）を計算する。
// 120BPMでは1拍=0.5秒（=1カウント=0.5秒）なので、8カウント=4秒、4カウント=2秒 になる。
// 将来BPMが可変になっても、この関数へ実際のBPM値を渡すだけで対応できる。
function countsToDurationMs(counts, bpm) {
  return (counts * 60 / bpm) * 1000;
}

// カウント数を「エイト」表示用の数値に変換する（1エイト＝8カウント）。
// 例: 1→0.125, 4→0.5, 8→1, 12→1.5, 16→2
function countsToEighths(counts) {
  return counts / COUNTS_PER_EIGHT;
}

// エイト数を、不要な小数点を省いた表示用文字列に整形する（例: 1→"1", 1.5→"1.5"）。
function formatEighthsLabel(counts) {
  const eighths = Math.round(countsToEighths(counts) * 1000) / 1000; // 浮動小数点誤差の保険
  return `${eighths}エイト`;
}

// 「秒数⇔カウント」変換（第Nエイトが何秒か／何秒地点が何カウント目か、など）の共通ラッパー。
// countsToDurationMsを重複実装せずそのまま再利用する。現在は音楽同期再生（keep/moveの実時間
// 計算）・Music Anchorの絶対秒計算・Music Seek逆算・再生中の音楽位置表示など、複数箇所で
// 実際に利用されている。
function countsToSeconds(counts, bpm) {
  return countsToDurationMs(counts, bpm) / 1000;
}
function secondsToCounts(seconds, bpm) {
  return (seconds * bpm) / 60;
}

// 秒数を "分:秒"（例: 0:05, 1:05, 3:21）形式の文字列にする。Music Bar の現在時間／総時間表示、
// および将来の「第Nエイト→秒数区間」表示などでも使い回せる汎用のpure helper。
// NaN・Infinity・null・undefined（metadata未読込時など）でも例外を投げず、安全に "0:00" を返す。
function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const totalSeconds = Math.floor(seconds);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ------------------------------------------------------------------
// Music Section 基盤（曲単位のカウントリセット用データ層）
// ------------------------------------------------------------------
// 音源全体（0秒〜music duration）の絶対時間軸はそのまま維持しつつ（12章）、その上に乗る
// 「1曲目／2曲目／SE／イントロ」などの区切りメタデータを Music Section として扱う。
// AudioBuffer・musicCurrentTime・durationSec等（既存のWeb Audio再生基盤）は一切分割・変更せず、
// Music Sectionはあくまでその上に載る作品データ（work.project.musicSections）として追加する（38章）。
//
// 1つのSection：
//   { id, name, startSec, countStartSec, bpm }
//   startSec      : そのセクション自体が音源全体の何秒地点から始まるか（16章）
//   countStartSec : そのセクションの1カウント目をどこから数えるか（17章）。
//                   イントロ・無音・SEなどカウントに乗らない区間を表現するため、
//                   startSecとは必ず別々に持てるようにしてある（18章）。
//   bpm           : そのセクション（曲）で使用するBPM。初期値はprojectBpmだが、Music Section
//                   BPM反映v1以降、Music Anchorの絶対時刻計算・keep phase・move phaseの実時間
//                   計算に実際に使用される。対象slideの属するSectionが特定できない場合だけ
//                   projectBpmへfallbackする（getEffectiveBpmForSlide参照）。

// 新規プロジェクト、または既存データにMusic Sectionが1つも無い場合に使う、最低1つ分の
// デフォルトSection（15章）。idを固定値にすることで、呼び出すたびに違うオブジェクトを
// 返しても「同じ1曲目」として扱われるようにする（レンダリングのたびにID自体は変わらない）。
function createDefaultMusicSection(bpm) {
  return { id: "section-default-1", name: "1曲目", startSec: 0, countStartSec: 0, bpm: clampBpm(bpm) };
}

// work.project.musicSections を安全に取得するhelper。getProjectBpm(work)と全く同じ考え方で、
// project自体が無い／musicSectionsが無い／空配列（古いデータ、Music Section機能実装前のデータ）
// の場合でもクラッシュせず、必ず最低1件のSection配列を返す（15章のfallback方針）。
function getMusicSections(work) {
  const sections = work && work.project && work.project.musicSections;
  if (Array.isArray(sections) && sections.length > 0) return sections;
  return [createDefaultMusicSection(getProjectBpm(work))];
}

// work.project.musicAsset を安全に取得するhelper。getProjectBpm/getMusicSectionsと同じ考え方で、
// project自体が無い・musicAssetが無い・形が壊れている（古いデータ、Multi Project音源管理v1
// 実装前のデータ）場合でもクラッシュせず、必ず「null（＝音源未登録）」または
// { id, fileName, mimeType } のどちらかを返す（Project / Workspace層のschema・後方互換）。
// 実体（Blob）はここには含まれない。実体はIndexedDB側（musicAssets object store）にあり、
// asset.id をキーに別途 idbGetMusicAsset() で取得する。
function getMusicAsset(work) {
  const asset = work && work.project && work.project.musicAsset;
  if (!asset || typeof asset !== "object" || typeof asset.id !== "string" || !asset.id) return null;
  return {
    id: asset.id,
    fileName: typeof asset.fileName === "string" ? asset.fileName : "",
    mimeType: typeof asset.mimeType === "string" ? asset.mimeType : "",
  };
}

// 28章：Music Sectionと第Nエイト（1エイト＝8カウント）から、そのエイトの絶対時間区間
// （音源全体を基準にした秒数）を求めるpure helper。countsToSeconds（BPM×カウント数の
// 既存計算）をそのまま再利用し、独自の時間計算ロジックを重複実装しない。
//   startCount = (eighthNumber - 1) * 8
//   endCount   = eighthNumber * 8
//   startSec   = section.countStartSec + countsToSeconds(startCount, section.bpm)
//   endSec     = section.countStartSec + countsToSeconds(endCount,   section.bpm)
function sectionEighthToTimeRange(section, eighthNumber) {
  const bpm = clampBpm(section && section.bpm);
  const countStartSec = section && Number.isFinite(section.countStartSec) ? section.countStartSec : 0;
  const startCount = (eighthNumber - 1) * COUNTS_PER_EIGHT;
  const endCount = eighthNumber * COUNTS_PER_EIGHT;
  return {
    startSec: countStartSec + countsToSeconds(startCount, bpm),
    endSec: countStartSec + countsToSeconds(endCount, bpm),
  };
}

// 31章：音源全体の絶対秒数から、それが「どのSectionの、何カウント目／第何エイト目」に
// あたるかを求めるpure helper。現在は「現在の音楽位置から設定」（setMusicAnchorFromCurrentMusicTimeCommit）・
// 音楽シーク逆算（resolveTimelineAtMusicTime経由ではなくこの関数自体は独立して）・再生中の
// 音楽位置表示（getMusicPlaybackPositionDisplay）などで実際に利用されている。
// Sectionの区切りはstartSec順で決まる設計（27章）のため、参照時にstartSec昇順へ
// 並べ替えてから、musicTimeSec以下の中で最も後ろのSectionを「現在のSection」とする
// （＝境界を超えたら次のSectionへ切り替わり、エイト番号もそこでリセットされる＝33章）。
// countStartSecより前の時間（イントロ・無音など）は、0エイト目や負のエイトとして扱わず、
// beforeCountStart: true という別フラグで区別する（32章）。
function timeSecToSectionPosition(musicTimeSec, musicSections) {
  if (!Number.isFinite(musicTimeSec) || !Array.isArray(musicSections) || musicSections.length === 0) {
    return null;
  }
  const sorted = musicSections
    .map((s, i) => ({ section: s, originalIndex: i }))
    .sort((a, b) => (a.section.startSec || 0) - (b.section.startSec || 0));
  let current = sorted[0];
  for (let i = 0; i < sorted.length; i++) {
    if (musicTimeSec >= (sorted[i].section.startSec || 0)) current = sorted[i];
    else break;
  }
  const section = current.section;
  const bpm = clampBpm(section.bpm);
  const countStartSec = Number.isFinite(section.countStartSec) ? section.countStartSec : (section.startSec || 0);
  if (musicTimeSec < countStartSec) {
    return { sectionId: section.id, sectionIndex: current.originalIndex, beforeCountStart: true, countPosition: 0, eighthPosition: 0 };
  }
  const countPosition = secondsToCounts(musicTimeSec - countStartSec, bpm);
  return {
    sectionId: section.id,
    sectionIndex: current.originalIndex,
    beforeCountStart: false,
    countPosition,
    eighthPosition: countPosition / COUNTS_PER_EIGHT,
  };
}

// ------------------------------------------------------------------
// 再生中の音楽位置表示 v1
// ------------------------------------------------------------------
// 絶対秒（timeSec）から、ユーザー向けの「○曲目・○エイト目・○カウント目」表示データを
// 組み立てるpure helper。Section判定・countStartSec前後の切り分けは、既存の
// timeSecToSectionPosition()を必ず再利用し、判定ロジックを二重実装しない（STEP1・STEP9）。
//
// エイト番号・カウント表示は「今鳴っている拍」を表示するため、小数のcountPositionを
// 先取りして丸めない（STEP2）。countPosition 0.0〜0.999...は1エイト目・1カウント目、
// 7.0〜7.999...は1エイト目・8カウント目、8.0〜8.999...は2エイト目・1カウント目、という
// ように、countPositionの整数部分だけを見る。浮動小数点誤差で7.999999999のような値が
// 本来の拍（8.0）より1つ手前に残ってしまわないよう、ごく小さいepsilonだけ加算してから
// Math.floorする（通常のMath.roundのように先の拍へ進めることはしない）。
//
// 内部のcountOffset（0〜7）→ユーザー表示（1〜8）の変換は、既存の
// musicAnchorCountOffsetToDisplayCountをそのまま再利用する（STEP7の既存表示思想を維持）。
//
// beforeCountStart（イントロ・カウント開始前の区間）の場合は、0エイト目・0カウント目・
// 負のカウントのような不自然な値を一切出さず、eighthNumber/displayCountをnullのまま返す。
// 呼び出し側（formatMusicPlaybackPositionLabel）は、この場合「イントロ」とだけ表示する。
function getMusicPlaybackPositionDisplay(timeSec, musicSections) {
  const position = timeSecToSectionPosition(timeSec, musicSections);
  if (!position) return null;
  const section = Array.isArray(musicSections) ? musicSections.find((s) => s.id === position.sectionId) || null : null;
  // Section削除直後などmusicSections側に該当が無くなった保険のケース（他画面のwarning表示と
  // 同じ考え方＝データは書き換えず表示だけ安全側に倒す）。
  const sectionName = section ? section.name : "（不明な楽曲）";
  if (position.beforeCountStart) {
    return {
      sectionId: position.sectionId,
      sectionIndex: position.sectionIndex,
      sectionName,
      beforeCountStart: true,
      eighthNumber: null,
      internalCountOffset: null,
      displayCount: null,
    };
  }
  const MUSIC_PLAYBACK_COUNT_EPSILON = 1e-9;
  const wholeCount = Math.floor(position.countPosition + MUSIC_PLAYBACK_COUNT_EPSILON);
  const eighthNumber = Math.floor(wholeCount / COUNTS_PER_EIGHT) + 1;
  const internalCountOffset = wholeCount % COUNTS_PER_EIGHT;
  return {
    sectionId: position.sectionId,
    sectionIndex: position.sectionIndex,
    sectionName,
    beforeCountStart: false,
    eighthNumber,
    internalCountOffset,
    displayCount: musicAnchorCountOffsetToDisplayCount(internalCountOffset),
  };
}

// getMusicPlaybackPositionDisplay()の結果を「♫ 2曲目　12エイト目・5カウント目」
// 「♫ 2曲目　イントロ」のような表示文字列へ整形する（STEP3・STEP6）。既存の
// formatMusicAnchorEighthCountLabel（Music Anchor UIと共通の「Nエイト目・Mカウント目」
// 定型文字列）をそのまま再利用し、二重実装しない。
function formatMusicPlaybackPositionLabel(display) {
  if (!display) return null;
  const sectionName = display.sectionName || "（不明な楽曲）";
  if (display.beforeCountStart) {
    return `♫ ${sectionName}　イントロ`;
  }
  return `♫ ${sectionName}　${formatMusicAnchorEighthCountLabel(display.eighthNumber, display.internalCountOffset)}`;
}

// ズーム関連
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.1;
const DEFAULT_VIEW_STATE = { zoom: 1, panX: 0, panY: 0 };

const DEFAULT_COLORS = [
  "#e8b84b", "#5aa9e6", "#e35d6a", "#7bc67e", "#c084fc",
  "#f28c38", "#4dd0c9", "#f06292", "#9ccc65", "#ba68c8",
];

// 舞台テーマカラー
const THEME = {
  bg: "#141318",
  panelBg: "#1d1b22",
  panelBg2: "#242129",
  border: "#37333f",
  borderSoft: "#2a2731",
  text: "#f2efe9",
  textDim: "#a79fb0",
  accent: "#e8b84b",
  danger: "#e35d6a",
  stageFloor: "#1a1720",
  gridLine: "#454050",
  gridLineHalf: "#332f3b",
};

// ------------------------------------------------------------------
// レスポンシブレイアウト用CSS
// ------------------------------------------------------------------
// PC・タブレット横向き（幅800px以上）では、workspace要素に display:grid を適用し、
// 「ステージ（可変幅）／編集サイドバー（320〜380px固定帯）」の2カラムを必ず生成する。
// 800px未満（タブレット縦向き・スマートフォン）では、workspaceを縦積みのflexに戻し、
// 従来通りステージ→編集パネルの順で表示する（ページ全体が通常通りスクロールする）。
// 同じ要素に矛盾したdisplay/width/flex-directionが残らないよう、ベース（狭い画面向け）の
// 宣言をメディアクエリ内で明示的に上書きする形にしている。
const RESPONSIVE_STYLES = `
  .slsim-app, .slsim-app *, .slsim-app *::before, .slsim-app *::after {
    box-sizing: border-box;
  }
  .slsim-app {
    height: 100vh;
    height: 100dvh;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow-x: hidden;
  }
  .slsim-header {
    flex-shrink: 0;
    position: sticky;
    top: 0;
    z-index: 30;
  }

  /* ---- ベース（800px未満）：ステージ→編集パネルの縦並び。workspace自体がスクロールする ---- */
  .slsim-workspace {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .slsim-stage-pane {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    min-width: 0;
    min-height: 420px;
    padding: 12px;
  }
  .slsim-sidebar {
    display: flex;
    flex-direction: column;
    gap: 20px;
    min-width: 0;
    width: 100%;
    padding: 16px;
    background: ${THEME.panelBg};
    border-top: 1px solid ${THEME.border};
    overflow-y: visible;
  }

  .slsim-help-panel {
    background: ${THEME.panelBg2};
    border: 1px solid ${THEME.borderSoft};
    border-radius: 12px;
    padding: 12px 14px;
  }
  .slsim-help-panel h3 {
    font-size: 12px;
    font-weight: 700;
    color: ${THEME.accent};
    margin: 10px 0 4px;
  }
  .slsim-help-panel h3:first-child {
    margin-top: 0;
  }
  .slsim-help-panel ul {
    margin: 0;
    padding-left: 18px;
    list-style: disc;
  }
  .slsim-help-panel li {
    font-size: 11.5px;
    line-height: 1.6;
    color: ${THEME.textDim};
  }

  /* サイドバー切替ボタンは800px未満では意味を持たないため非表示にする（狭い画面では常時表示のため） */
  .slsim-sidebar-toggle {
    display: none;
  }

  /* ---- 800px以上：CSS Gridで「ステージ｜サイドバー」の2カラムに固定 ---- */
  @media (min-width: 800px) {
    .slsim-sidebar-toggle {
      display: inline-flex;
    }
    .slsim-workspace {
      display: grid;
      grid-template-columns: minmax(0, 1fr) clamp(320px, 28vw, 380px);
      grid-template-rows: minmax(0, 1fr);
      flex-direction: row; /* display:gridが最優先されるが、矛盾する値を残さないよう明示的に上書き */
      min-height: 0;
      height: 100%;
      overflow: hidden; /* ページではなくsidebar側だけをスクロールさせるため、workspace自体はスクロールしない */
    }
    .slsim-stage-pane {
      flex-shrink: 1;
      min-width: 0;
      min-height: 0;
      height: 100%;
      overflow: hidden;
    }
    .slsim-sidebar {
      width: auto;
      min-width: 320px;
      max-width: 380px;
      height: 100%;
      min-height: 0;
      overflow-y: auto;
      border-top: none;
      border-left: 1px solid ${THEME.border};
    }

    /* サイドバー非表示（sidebarOpen=false）：1カラムにしてステージへ全幅を割り当てる。
       右側に空の列や余白を残さないよう、gridの列定義自体を1本にする。 */
    .slsim-workspace.slsim-sidebar-collapsed {
      grid-template-columns: minmax(0, 1fr);
    }
    .slsim-workspace.slsim-sidebar-collapsed .slsim-sidebar {
      display: none;
    }
  }

  @media (max-width: 599px) {
    .slsim-sidebar input,
    .slsim-sidebar select,
    .slsim-sidebar button {
      min-height: 40px;
    }
  }

  /* ---- Bottom Control Bar v2.1 / 3-Card Guaranteed Layout ----
     v2はviewport幅のmedia queryで「999px以下で近隣カードを1枚に」「759px以下で
     近隣カード自体を非表示に」という縮退をしていたが、サイドバー開閉状態などにより
     CompositionBar自身の実際の幅とviewport幅が一致しないケースがあり、本来3枚
     表示できる余裕があるのに早期に縮退してしまう問題があった（v2 Known Issues）。
     v2.1では、viewport幅のmedia queryは廃止し、CompositionBar自身の実測幅を
     ResizeObserverで測定してJS側（CompositionBar内のcompactLevel state）で
     slsim-cb-compact-1 / slsim-cb-compact-2 クラスを付け外しする方式に変更した
     （9章）。ResizeObserverのコールバックはReact stateの更新のみを行い、
     document/bodyのスクロールやscrollIntoViewは一切呼ばない。
     優先順位（10章）：1.再生操作・2.移動時間・3.構成管理は、どの縮退レベルでも
     一切変えない。レベル1では先に「編集に戻る」表示の短縮とgapの圧縮（JS側の
     inline styleで実施）だけを行い、それでも収まらない場合の最終手段として
     レベル2でだけ近隣カードを現在の1枚のみへ縮退する。 */
  .slsim-composition-nearby {
    /* 近隣カード領域は幅をJS側（CompositionBar）で明示指定するため、中身が
       その幅からはみ出しても右隣の構成管理ブロックへ視覚的に漏れ出さないよう、
       常にoverflow:hiddenで切り取る（v2で直した干渉バグの再発防止）。 */
    overflow: hidden;
  }
  .slsim-cb-compact-2 .slsim-nearby-card:not(.slsim-nearby-card-active) {
    display: none;
  }
`;

// ------------------------------------------------------------------
// ユーティリティ
// ------------------------------------------------------------------
let idCounter = 1;
function makeId(prefix) {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

// Keyboard Editing v1：入力欄（input / textarea / select / contenteditable）へフォーカス中かどうかの
// 判定を1箇所へ集約するhelper（26章）。既存のUndo/Redo・ズームショートカットが持っていた
// インライン判定（tag === "INPUT" 等）もこの関数へ統一し、新しく追加するCopy/Paste/Delete/Backspaceの
// 判定と重複実装しない。構成名・BPM・Music SectionのstartSec等、input要素であれば種類を問わず
// 対象にする（27章：number inputも含む）。
function isEditableTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!target.isContentEditable;
}

// Keyboard Editing v1：構成コピー（copiedSlideRef）用のdeep copy helper。
// コピー時・貼り付け時の両方でこれを通すことで、「コピー後に元slideを変更してもclipboardが
// 影響を受けない」「同じclipboardから複数回貼り付けても、貼り付けたslide同士がplacements
// オブジェクトを共有しない」を両方満たす（11章）。work内のslide/placementsはFile・AudioBuffer・
// 関数などシリアライズ不可能な値を含まないプレーンデータのみのため、structuredClone（対応環境）
// またはJSON経由のフォールバックで安全にdeep copyできる。
function deepCopyPlainObject(obj) {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(obj);
    } catch (err) {
      // 万一失敗した場合のみ下のJSONフォールバックへ進む
    }
  }
  return JSON.parse(JSON.stringify(obj));
}

function snapHalf(v) {
  return Math.round(v * 2) / 2;
}

// Performer Placement 0.25 Snap v1：出演者placementのx/y座標専用のsnap helper。
// 既存のsnapHalf（0.5単位）は、①キープ／移動の進捗表示（roundToHalfCount）、②曲線移動の
// 初期waypoint生成（computeInitialWaypoint）、③waypointドラッグ、④出演者の自動整列
// （arrangeInZone・findInitialStagePlacement・moveIdsToArea）など、出演者placement以外にも
// 広く使われているため、そのままでは変更できない（今回0.25化するのは正式な出演者placementの
// x/yだけで、waypoint・自動整列の間隔は現状維持＝17章）。そのため既存snapHalfは一切変更せず、
// 出演者placementの手動配置（ドラッグ・数値入力・複数選択移動）専用に、この
// snapPlacementCoordinate()を新設して一本化する（13章：snap実装を複数乱立させない）。
// 0.5は0.25の整数倍のため、既存作品の0/0.5/1/1.5…座標はこの関数を通してもそのままの値になり、
// データmigrationは不要（18章）。JavaScriptの浮動小数点誤差対策として、四捨五入前に
// 小さな丸め補正（1e-9相当の許容）を挟まず、Math.roundの標準的な四捨五入（0.5以上切り上げ）に
// 委ねる（後述のテストケースK〜Pで境界値を確認済み）。
function snapPlacementCoordinate(v) {
  return Math.round(v * 4) / 4;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// progress（0〜1）とカウント数から、0.5カウント刻みの「現在何カウント目か」を計算する。
// キープ進捗表示・移動進捗表示（連続再生のラベル、スクラバーのカウント表示）の両方から
// 共通で使い、丸めロジックを二重実装しない（snapHalfをそのまま再利用する）。
function roundToHalfCount(progress, totalCounts) {
  return snapHalf(clamp(progress, 0, 1) * totalCounts);
}

// ------------------------------------------------------------------
// 構成間移動アニメーション：直線補間（v1）
// ------------------------------------------------------------------
// fromPlacements（構成A） → toPlacements（構成B）を progress（0〜1）で直線補間した
// 「表示専用」の placements を返す。slides / 実データの placements は一切変更しない。
// area による特殊処理は行わず、ステージ⇔袖⇔舞台奥待機など、すべて開始座標と
// 終了座標の間を単純な直線で結ぶ。
//
// データ欠損への対応（クラッシュ防止）：
//   ・開始側にしか placement がない出演者 → 終了位置に固定（＝開始位置のまま表示）
//     ※ 仕様上「終了placementがない場合 → 開始位置に固定」に対応
//   ・終了側にしか placement がない出演者 → 開始位置に固定（＝終了位置のまま表示）
//     ※ 仕様上「開始placementがない場合 → 終了位置に固定」に対応
//   ・どちらにも存在しない出演者は結果に含めない（呼び出し側で自然に非表示になる）
//
// 将来、waypoints・出演者ごとの移動時間・曲線移動などを追加する場合も、この関数の
// シグネチャ（fromPlacements, toPlacements, progress）はそのまま維持しつつ、
// 内部処理だけを拡張できるようにしてある。
function interpolatePlacements(fromPlacements, toPlacements, progress) {
  const from = fromPlacements || {};
  const to = toPlacements || {};
  const ids = new Set([...Object.keys(from), ...Object.keys(to)]);
  const result = {};
  ids.forEach((id) => {
    const a = from[id];
    const b = to[id];
    if (a && b) {
      result[id] = {
        x: lerp(a.x, b.x, progress),
        y: lerp(a.y, b.y, progress),
        // area は表示上の分類にのみ使うため、再生完了の瞬間にのみ切り替える
        // （途中は開始側のエリアのまま扱う＝終了側エリアへの特殊な出入り処理はv1では行わない）。
        area: progress >= 1 ? b.area : a.area,
        // 姿勢 v1.1：pose も area と全く同じ考え方で扱う（姿勢そのものを補間しない＝PART D）。
        // 移動中は開始側のposeを維持し、到着した瞬間（progress>=1）にだけ終了側へ切り替える。
        pose: progress >= 1 ? b.pose : a.pose,
      };
    } else if (a && !b) {
      // 終了placementがない → 開始位置に固定
      result[id] = { ...a };
    } else if (!a && b) {
      // 開始placementがない → 終了位置に固定
      result[id] = { ...b };
    }
  });
  return result;
}

// ------------------------------------------------------------------
// 構成間アニメーションv2：移動軌跡（表示専用レイヤー）
// ------------------------------------------------------------------
// fromPlacements（現在の構成）→ toPlacements（次の構成）の間で、出演者ごとの
// 「開始座標→終了座標」を結ぶ直線情報を計算する純粋関数。slides / placements
// そのものへは一切書き込まず、呼び出し側（App）が現在の構成・次の構成の
// placementsから毎回計算し直す“表示専用”の情報として扱う。
// 戻り値: [{ id, from: {x,y}, to: {x,y} }]（単位はplacementsと同じステージ単位座標）
// 平面図・俯瞰客席ビュー・将来のExport用StageViewのいずれからも同じ形式のまま
// 再利用できるよう、UIやSVG座標には一切依存させていない。
//
// v3（曲線移動）で、第4引数 pathConfig（省略可・{[performerId]: {type, waypoint}}）を
// 追加した。省略時は従来通り全員「直線」として扱われ、戻り値の形も変わらないため、
// 既存の呼び出し側（v1/v2時点のコード）への影響はない。
// pathConfigで対象出演者が type:"curve" として設定されている場合のみ、戻り値に
// type:"curve" と waypoint（通過点の舞台座標）を含める。
//   ・waypoints（2点以上）を挟んだ曲線移動
//   ・エリア（袖・舞台奥待機など）をまたぐ際の特殊な経路表現
//   ・出演者ごとの移動距離・所要時間の算出
// は今回（v3）も対象外とし、将来この関数のインターフェースを壊さずに拡張できるようにしてある。
function computeTransitionPaths(fromPlacements, toPlacements, pathConfig) {
  const from = fromPlacements || {};
  const to = toPlacements || {};
  const paths = [];
  Object.keys(from).forEach((id) => {
    const a = from[id];
    const b = to[id];
    // 開始・終了の両方にplacementが存在する出演者のみを対象にする
    // （片方にしか存在しない場合は「移動」として表現できないため対象外とする）
    if (!a || !b) return;
    const cfg = pathConfig && pathConfig[id];
    const isCurve = !!(cfg && cfg.type === "curve" && cfg.waypoint);
    if (!isCurve && a.x === b.x && a.y === b.y) return; // 直線かつ移動していない出演者の軌跡は描かない
    const path = { id, from: { x: a.x, y: a.y }, to: { x: b.x, y: b.y }, type: isCurve ? "curve" : "linear" };
    if (isCurve) path.waypoint = { x: cfg.waypoint.x, y: cfg.waypoint.y };
    paths.push(path);
  });
  return paths;
}

// 移動軌跡の「参照方向モード」（次に／前に）から、軌跡計算に渡すべき
// fromPlacements / toPlacements を決定する共通関数。
// 「どの2構成を参照するか」（この関数の責務）と「軌跡をどう計算・描画するか」
// （computeTransitionPaths / trajectoryArrowPoints の責務）を分離することで、
// 「次に」「前に」で軌跡描画コードを二重実装しないようにしている。
//   mode === "next"    : 現在の構成 → 次の構成（現在表示中の出演者が次にどこへ行くか）
//   mode === "previous" : 前の構成 → 現在の構成（現在表示中の出演者が前にどこから来たか。
//                          矢印は実際の時間の流れ通り「過去→現在」で、先端は現在位置になる）
// 参照先の構成が存在しない場合（最初の構成での"previous"、最後の構成での"next"）は
// nullを返し、呼び出し側はエラーにせず単純に軌跡なし（空配列）として扱う。
// 戻り値には fromSlideId / toSlideId も含める（曲線経路の保存キー＝fromSlideIdを
// 呼び出し側（App）が特定できるようにするため。v2時点では未使用だったが、
// v3の曲線移動編集でどの遷移を編集対象にするかを決めるために利用する）。
function getTrajectoryPlacements({ slides, currentSlideIndex, mode }) {
  if (mode === "previous") {
    const prevSlide = slides[currentSlideIndex - 1];
    const currentSlide = slides[currentSlideIndex];
    if (!prevSlide || !currentSlide) return null;
    return {
      fromSlideId: prevSlide.id,
      toSlideId: currentSlide.id,
      fromPlacements: prevSlide.placements,
      toPlacements: currentSlide.placements,
    };
  }
  // デフォルトは "next"
  const currentSlide = slides[currentSlideIndex];
  const nextSlide = slides[currentSlideIndex + 1];
  if (!currentSlide || !nextSlide) return null;
  return {
    fromSlideId: currentSlide.id,
    toSlideId: nextSlide.id,
    fromPlacements: currentSlide.placements,
    toPlacements: nextSlide.placements,
  };
}

// ------------------------------------------------------------------
// 構成間アニメーションv3：1通過点だけの曲線移動
// ------------------------------------------------------------------
// 経路設定（直線／曲線）は「表示専用state」ではなく、将来のPDF/PNG出力・AI移動最適化・
// waypoints追加・移動距離計算にも使えるよう「作品データ」として保存する。
// transitionCountsと全く同じ考え方で、work直下に「移動元スライドのid」をキーにした
// 独立マップとして持たせる。さらに出演者ごとに異なる経路を持てるよう、その内側に
// performerIdをキーにした設定を1段ネストしている。
//   work.transitionPaths: {
//     [移動元スライドのid]: {
//       [performerId]: { type: "linear" } | { type: "curve", waypoint: { x, y } }
//     }
//   }
// 「直線」が既定値のため、未設定の出演者（＝上記オブジェクトにエントリが無い）は
// 常に直線として扱う（getPerformerTransitionPathがフォールバックする）。これにより、
// 「全員の経路を設定しないと使えない」状態を避け、曲線にした出演者分だけデータを持つ
// 疎な構造になる。
//
// キーが「移動元スライドのid」だけである点もtransitionCountsと同じで、これにより
// 「構成3→構成4」の曲線を構成3側で「次に」を見ても、構成4側で「前に」を見ても、
// 同じ1つのデータ（work.transitionPaths["構成3のid"]["対象performerId"]）を
// 参照することになり、経路データを二重に保存することがない。

// 指定したperformerの、指定した遷移（fromSlideId起点）における経路設定を取得する。
// 未設定の場合は既定値（直線）にフォールバックする。
function getPerformerTransitionPath(transitionPaths, fromSlideId, performerId) {
  const forSlide = transitionPaths && transitionPaths[fromSlideId];
  const cfg = forSlide && forSlide[performerId];
  if (cfg && cfg.type === "curve" && cfg.waypoint) {
    return { type: "curve", waypoint: { x: cfg.waypoint.x, y: cfg.waypoint.y } };
  }
  return { type: "linear" };
}

// 構成の追加・削除・並べ替えの後で呼び出す。reconcileTransitionCountsと全く同じ考え方で、
// 変更前(oldSlides)と変更後(newSlides)を比較し、「移動元→移動先」の隣接ペアが
// 1件も変化していない遷移の経路データだけを引き継ぎ、ペアが変わってしまった箇所は
// 単純に破棄する（＝該当出演者は既定値の直線へ自動的にフォールバックする）。
// 複雑な自動引き継ぎは行わず、「安全でシンプルな挙動」を優先する。
function reconcileTransitionPaths(transitionPaths, oldSlides, newSlides) {
  const oldNextId = new Map();
  for (let i = 0; i < oldSlides.length - 1; i += 1) {
    oldNextId.set(oldSlides[i].id, oldSlides[i + 1].id);
  }
  const next = {};
  for (let i = 0; i < newSlides.length - 1; i += 1) {
    const fromId = newSlides[i].id;
    const toId = newSlides[i + 1].id;
    if (
      oldNextId.get(fromId) === toId &&
      transitionPaths &&
      Object.prototype.hasOwnProperty.call(transitionPaths, fromId)
    ) {
      next[fromId] = transitionPaths[fromId];
    }
  }
  return next;
}

// 初めて「曲線」に切り替えた際の通過点の初期位置を計算する。
// 基本は開始位置と終了位置の中点だが、中点そのままだと見た目が直線と変わらないため、
// 生成時だけ移動方向に対して垂直な向きへごくわずか（0.5単位）オフセットする。
// 大きく曲げすぎないよう、オフセット量は固定の小さい値のみを使う。
function computeInitialWaypoint(fromPos, toPos) {
  const midX = (fromPos.x + toPos.x) / 2;
  const midY = (fromPos.y + toPos.y) / 2;
  const dx = toPos.x - fromPos.x;
  const dy = toPos.y - fromPos.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    // 開始・終了がほぼ同一地点の場合は、オフセット方向を決められないので中点のみ返す
    return { x: snapHalf(midX), y: snapHalf(midY) };
  }
  const OFFSET_UNITS = 0.5; // 初期生成時だけの小さな控えめなオフセット量
  const px = -dy / len;
  const py = dx / len;
  return { x: snapHalf(midX + px * OFFSET_UNITS), y: snapHalf(midY + py * OFFSET_UNITS) };
}

// ------------------------------------------------------------------
// 待機エリア間スマート経路 v1
// ------------------------------------------------------------------
// 「一般的な衝突回避AI・経路探索は実装しない」という方針のもと、下手袖／上手袖／
// 舞台奥待機のあいだを移動する際に単純な直線だとステージ本体を横断してしまう
// 組み合わせだけを対象に、既存のcurve（type:"curve", waypoint）形式で使う
// 初期waypointを1つだけ計算する、幾何ベースの単純なheuristic。
// 新しい経路形式（複数waypoint・経路探索など）は一切追加しない。
//
// 対象area組み合わせをここに集約し、他の場所にarea文字列の組み合わせを
// ハードコードしないようにする（9章）。
const SMART_WAITING_AREA_PAIRS = new Set([
  "stageLeft>upstageBackstage",
  "upstageBackstage>stageLeft",
  "stageRight>upstageBackstage",
  "upstageBackstage>stageRight",
  "stageLeft>stageRight",
  "stageRight>stageLeft",
]);

// from/toのarea組み合わせが、スマート経路の対象かどうかを判定する純粋関数。
// stage⇔stage・stage⇔袖・stage⇔舞台奥待機など、それ以外の組み合わせは
// 常にfalse（＝既存の直線移動のまま）。
function isSmartWaitingAreaTransition(fromArea, toArea) {
  if (!fromArea || !toArea) return false;
  return SMART_WAITING_AREA_PAIRS.has(`${fromArea}>${toArea}`);
}

// stage / zones（computeZonesの戻り値）の幾何から、対象area間移動のための
// waypointを1つだけ計算する。固定数値は使わず、常にzonesの座標範囲から算出するため、
// ステージサイズ（stage.width / stage.depth）が変わっても追従する（5章）。
//   ・袖 ↔ 舞台奥待機：「ステージ本体の奥側（zones.stage.yMax）」かつ
//     「ステージ外側寄り（該当する袖ゾーンの左右方向の中央）」にwaypointを置く（6章）。
//     これにより、袖から一度ステージ奥の境界線付近まで進んでから舞台奥へ入る、
//     不自然にステージ中央を横切らない経路になる。
//   ・左袖 ↔ 右袖：waypoint数が1つしかないため完全なL字にはできないが、
//     舞台奥（upstageBackstage）側へ寄せた1点を経由させることで、ステージ中央を
//     横切る直線よりも自然な経路にする（7章）。
// 対象外の組み合わせ、またはfromPlacement/toPlacementが無い場合はnullを返す。
function computeSmartWaitingAreaWaypoint({ fromPlacement, toPlacement, stage, zones }) {
  if (!fromPlacement || !toPlacement || !zones) return null;
  const fromArea = fromPlacement.area;
  const toArea = toPlacement.area;
  if (!isSmartWaitingAreaTransition(fromArea, toArea)) return null;

  // ステージ本体と舞台奥待機の境界線（＝「ステージ本体の奥側」の基準Y座標）
  const elbowY = zones.stage.yMax;
  // 指定した袖ゾーンの左右方向の中央（＝「ステージ外側寄り」の基準X座標）
  const wingCenterX = (zone) => (zone.xMin + zone.xMax) / 2;

  if (
    (fromArea === "stageLeft" && toArea === "upstageBackstage") ||
    (fromArea === "upstageBackstage" && toArea === "stageLeft")
  ) {
    return { x: snapHalf(wingCenterX(zones.stageLeft)), y: snapHalf(elbowY) };
  }
  if (
    (fromArea === "stageRight" && toArea === "upstageBackstage") ||
    (fromArea === "upstageBackstage" && toArea === "stageRight")
  ) {
    return { x: snapHalf(wingCenterX(zones.stageRight)), y: snapHalf(elbowY) };
  }
  // 左袖 ↔ 右袖：舞台奥待機ゾーンのやや手前寄り（少し外側へ寄せた位置）・中央Xを経由する
  const backZone = zones.upstageBackstage;
  const backY = backZone.yMin + (backZone.yMax - backZone.yMin) * 0.35;
  return { x: snapHalf(0), y: snapHalf(backY) };
}

// スマート経路の対象なら、既存のcurve形式（type:"curve", waypoint）のエントリを
// 1件構築する。source:"auto"のタグだけを付加し、新しいデータ形式は作らない（3章・12章）。
// 対象外ならnullを返す（呼び出し側は既定の直線のまま扱う）。
function buildAutoTransitionPath({ fromPlacement, toPlacement, stage, zones }) {
  const waypoint = computeSmartWaitingAreaWaypoint({ fromPlacement, toPlacement, stage, zones });
  if (!waypoint) return null;
  return { type: "curve", waypoint, source: "auto" };
}

// work.transitionPaths（ユーザーが手動で設定した経路。source/isAutoが無い既存データも
// 含めすべて「手動」として扱う＝13章のfallback方針）を土台に、まだ経路データが無い
// performer×遷移の組み合わせについてだけ、スマート経路の初期提案を「表示専用」で
// 補完した実効設定（effective transitionPathConfig）を計算する純粋関数。
//
// 重要：ここで計算した自動waypointはwork（作品データ）へは一切書き込まない。
// 「新しいtransitionが生まれた／areaが変わった」タイミングでの初期設定（10章）を、
// 個別の出演者移動・エリア変更のすべての呼び出し箇所（setPlacementCommit／dragGroup／
// moveIdsToArea／applyBulkAxisLive等、多数に分散している）へ後追いで書き込みロジックを
// 仕込むのではなく、「現在のslides・placementsから毎回computeし直す派生値」として扱うことで、
//   ・ユーザーの手動設定（work.transitionPathsに実データがある）は常に最優先される（11章）
//   ・auto waypointはUndo/Redoの対象に一切ならない（＝作品データを一切変更しないため、
//     「1操作＝1履歴」を破ることが構造的に起こり得ない。24章）
//   ・構成の追加・削除・並べ替え後も、reconcileTransitionPaths（手動データの引き継ぎ）を
//     そのまま使いつつ、auto側は常に最新のslides構成から再計算されるため特別扱いが要らない（26章）
// を同時に満たす設計にしている。
function computeEffectiveTransitionPathConfig(slides, transitionPaths, stage, zones) {
  const result = {};
  if (!slides || slides.length < 2) return result;
  for (let i = 0; i < slides.length - 1; i += 1) {
    const fromSlide = slides[i];
    const toSlide = slides[i + 1];
    const rawForSlide = (transitionPaths && transitionPaths[fromSlide.id]) || null;
    const fromPlacements = fromSlide.placements || {};
    const toPlacements = toSlide.placements || {};
    const ids = new Set([...Object.keys(fromPlacements), ...Object.keys(toPlacements)]);
    let mergedForSlide = null;
    ids.forEach((id) => {
      const raw = rawForSlide && rawForSlide[id];
      if (raw) return; // 手動設定（source/isAutoが無い既存データも含む）は常に最優先。上書きしない
      const autoPath = buildAutoTransitionPath({
        fromPlacement: fromPlacements[id],
        toPlacement: toPlacements[id],
        stage,
        zones,
      });
      if (!autoPath) return; // 対象外の移動は既定の直線のまま（エントリを作らない）
      if (!mergedForSlide) mergedForSlide = {};
      mergedForSlide[id] = autoPath;
    });
    if (rawForSlide || mergedForSlide) {
      result[fromSlide.id] = { ...(rawForSlide || {}), ...(mergedForSlide || {}) };
    }
  }
  return result;
}

// 二次ベジェ曲線 B(t) = (1-t)^2 P0 + 2(1-t)t P1 + t^2 P2 上の点を計算する純粋関数。
// P0=開始位置, P1=通過点（制御点として扱う）, P2=終了位置。
// 「通過点をドラッグすると軌跡が曲がる」という直感的な操作になれば十分なため、
// 厳密にP1を通過する補間ではなく、標準的な二次ベジェの制御点として扱う
// （t=0.5付近で曲線はP1に引き寄せられるように通るため、体感的には「そこを通る」ように見える）。
function quadraticBezierPoint(p0, p1, p2, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
    y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
  };
}

// アニメーション再生用：既存のinterpolatePlacements（直線補間・欠損対応込み）はそのまま
// 変更せず、まずそれを使って全出演者分の「基準となる直線補間結果」を計算する。
// その上で、pathConfig（{[performerId]: {type, waypoint}}）で曲線が指定されている
// 出演者だけ、二次ベジェ曲線上の位置で上書きする。
// これにより、同じ構成間で「1番→直線／2番→曲線／3番→直線」のように混在していても、
// 直線移動する出演者の挙動はinterpolatePlacements単体を使った場合と完全に同じになる。
function interpolatePlacementsWithPaths(fromPlacements, toPlacements, progress, pathConfig) {
  const base = interpolatePlacements(fromPlacements, toPlacements, progress);
  if (!pathConfig) return base;
  const from = fromPlacements || {};
  const to = toPlacements || {};
  Object.keys(pathConfig).forEach((id) => {
    const cfg = pathConfig[id];
    if (!cfg || cfg.type !== "curve" || !cfg.waypoint) return;
    const a = from[id];
    const b = to[id];
    if (!a || !b) return; // 開始・終了の両方が揃っている出演者のみ曲線を適用する
    const point = quadraticBezierPoint(a, cfg.waypoint, b, progress);
    // 姿勢 v1.1：曲線移動で座標を上書きする際も、interpolatePlacements側と同じ
    // 「途中は開始側pose、progress>=1で終了側pose」のルールをposeにも適用する（PART D）。
    base[id] = { x: point.x, y: point.y, area: progress >= 1 ? b.area : a.area, pose: progress >= 1 ? b.pose : a.pose };
  });
  return base;
}

// 軌跡の矢じり（矢印の三角形）の頂点座標を計算する純粋関数。
// SVGの<marker>要素に頼らず、平面図・俯瞰客席ビューのどちらでも同じ計算で
// 矢じりのpolygonを描けるようにするための共通ヘルパー。
// (x1,y1)→(x2,y2) の向きに、終点(x2,y2)を先端として三角形を作る。
function trajectoryArrowPoints(x1, y1, x2, y2, size) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const backX = x2 - ux * size;
  const backY = y2 - uy * size;
  const halfW = size * 0.55;
  return `${x2},${y2} ${backX + px * halfW},${backY + py * halfW} ${backX - px * halfW},${backY - py * halfW}`;
}

function roundZoom(z) {
  return Math.round(clamp(z, ZOOM_MIN, ZOOM_MAX) * 100) / 100;
}

// 指定した「見せたい範囲」（コンテンツ座標系の矩形）が画面いっぱいに収まるような
// zoom / panX / panY を計算する。TopView・OverheadAudienceView の両方から、
// ビューごとの座標系（bounds）を渡して共通で使う。
function computeFitViewState(targetMinX, targetMinY, targetMaxX, targetMaxY, bounds, padding = 0.86) {
  const targetW = Math.max(40, targetMaxX - targetMinX);
  const targetH = Math.max(40, targetMaxY - targetMinY);
  const rawZoom = Math.min(bounds.totalW / targetW, bounds.totalH / targetH) * padding;
  const zoom = roundZoom(rawZoom);
  const targetCenterX = (targetMinX + targetMaxX) / 2;
  const targetCenterY = (targetMinY + targetMaxY) / 2;
  const viewCenterX = bounds.totalW / 2;
  const viewCenterY = bounds.totalH / 2;
  return {
    zoom,
    panX: zoom * (viewCenterX - targetCenterX),
    panY: zoom * (viewCenterY - targetCenterY),
  };
}

// zoom/pan を反映した SVG transform 文字列。全ビュー共通のズーム原点計算。
function viewGroupTransform(viewState, bounds) {
  const cx = bounds.totalW / 2;
  const cy = bounds.totalH / 2;
  return `translate(${cx + viewState.panX} ${cy + viewState.panY}) scale(${viewState.zoom}) translate(${-cx} ${-cy})`;
}

// ズームアウト時（zoom < 1）も出演者の番号・シルエットが最低限の大きさを保つよう
// 逆スケールをかけるための係数。zoom >= 1 のときは 1（通常通り拡大される）。
function figureMinSizeCompensation(zoom) {
  return zoom < 1 ? 1 / zoom : 1;
}

// 出演者番号の表示用フォントサイズを桁数に応じて調整する。
// 1桁・2桁のあいだで見た目の印象差が大きく出ないよう、基本的にはほぼ同じサイズにし、
// 2桁が○の中に収まりやすいよう、ごくわずかだけ縮小する（baseSize自体は「2桁でも
// 窮屈にならない」サイズ感を基準に呼び出し側で決める）。
function performerNumberFontSize(baseSize, number) {
  const digits = String(number).length;
  return digits >= 2 ? baseSize * 0.92 : baseSize;
}

// 俯瞰客席ビュー専用：胸の番号のフォントサイズを、実際の胸の横幅（FrontFigureの
// torsoW * 2 と同じ計算＝chestWidth）を基準に計算する。
// 「数字が必ず胴体内に収まること」を最優先とし、chestWidthを超えるサイズには絶対にしない。
// 目安として1桁は胴体幅の50〜65%程度、2桁は1桁よりごくわずかに小さくする。
// chestWidthはproject()による遠近スケール・sizeCompを反映済みのheightPxから算出されるため、
// 身長（150/175cm）やzoomアウト時の最小サイズ補正にも自動で追従する。
function performerNumberFontSizeAudience(chestWidth, number) {
  const digits = String(number).length;
  const base = chestWidth * 0.58; // 1桁：胴体幅の約58%（50〜65%の目安の範囲内）
  const size = digits >= 2 ? base * 0.88 : base; // 2桁：1桁よりごくわずかに縮小（0.85〜0.9の目安）
  // 安全装置：どんな場合でもchestWidthを超えないようクランプする（数字が胴体からはみ出さない）
  return Math.max(9, Math.min(size, chestWidth * 0.95));
}

// ------------------------------------------------------------------
// エリア（ステージ本体 / 下手袖 / 上手袖 / 舞台奥待機）
// ------------------------------------------------------------------
// 出演者の位置は単なる {x, y} ではなく {x, y, area} で管理する。
// area: "stage" | "stageLeft" | "stageRight" | "upstageBackstage" | null
//   （null = どのエリアにも属さない = 完全な範囲外＝警告対象）
// このオブジェクトは将来、移動アニメーションの moveFrom / moveTo /
// waypoints の各スナップショットにもそのまま使い回せる形にしてある。
const AREA_LABELS = {
  stage: "ステージ上",
  stageLeft: "下手袖",
  stageRight: "上手袖",
  upstageBackstage: "舞台奥待機",
};

// プルダウン等で表示する際の並び順（ステージ上 → 上手袖 → 下手袖 → 舞台奥待機）
const AREA_ORDER = ["stage", "stageRight", "stageLeft", "upstageBackstage"];

// 待機エリアサイズ最適化：下手袖・上手袖・舞台奥のサイズは、固定pxではなく
// ステージ幅・奥行きに対する比率から自動計算する。ステージ本体を視覚的な主役にするため、
// 従来（幅の30%・奥行きの50%）よりも大幅にコンパクトな比率へ変更した。
//   SIDE_WAITING_RATIO    … 下手袖・上手袖（片側）＝stageWidthに対する比率
//   UPSTAGE_WAITING_RATIO … 舞台奥＝stageDepthに対する比率
// 極端に小さい／大きいステージでも待機エリアが「狭すぎる」「広がりすぎる」ことがないよう、
// clamp()で最低限・最大限のスペースを確保する。
//   SIDE_WAITING_MIN/MAX_UNITS    … 片側の下手袖・上手袖の最小・最大値（マス単位）
//   UPSTAGE_WAITING_MIN/MAX_UNITS … 舞台奥の最小・最大値（マス単位）
// stage.width/stage.depthから毎回導出する値であり、Project/work schemaへは一切保存しない
// （ステージサイズを変更すれば自動的に追従する。既存Projectのplacement座標もこの関数の
// 計算結果次第で新しい狭いzoneの外に出る可能性はあるが、area判定は既存のisBeyondAllAreas等の
// 「範囲外なら警告アイコンを出す」仕組みがそのまま吸収するため、新しいmigrationは不要）。
const SIDE_WAITING_RATIO = 0.125;
const SIDE_WAITING_MIN_UNITS = 1.5;
const SIDE_WAITING_MAX_UNITS = 4;
const UPSTAGE_WAITING_RATIO = 0.2;
const UPSTAGE_WAITING_MIN_UNITS = 1.5;
const UPSTAGE_WAITING_MAX_UNITS = 4;

// グリッドが0.5マス単位で刻まれていることに合わせ、待機エリアのサイズも0.5マス単位へ丸める
// （例：stageDepth=10なら upstageBackstageDepth = 10*0.25 = 2.5マスちょうどになる）。
function roundToHalfUnit(v) {
  return Math.round(v * 2) / 2;
}

// ステージ設定から各エリアの座標範囲（ステージ座標系・単位のまま）を計算する
function computeZones(stage) {
  const halfW = stage.width / 2;
  const wingWidth = clamp(roundToHalfUnit(stage.width * SIDE_WAITING_RATIO), SIDE_WAITING_MIN_UNITS, SIDE_WAITING_MAX_UNITS);
  const backDepth = clamp(roundToHalfUnit(stage.depth * UPSTAGE_WAITING_RATIO), UPSTAGE_WAITING_MIN_UNITS, UPSTAGE_WAITING_MAX_UNITS);
  return {
    wingWidth,
    backDepth,
    stage: { xMin: -halfW, xMax: halfW, yMin: 0, yMax: stage.depth },
    stageLeft: { xMin: -halfW - wingWidth, xMax: -halfW, yMin: 0, yMax: stage.depth },
    stageRight: { xMin: halfW, xMax: halfW + wingWidth, yMin: 0, yMax: stage.depth },
    upstageBackstage: {
      xMin: -halfW - wingWidth,
      xMax: halfW + wingWidth,
      yMin: stage.depth,
      yMax: stage.depth + backDepth,
    },
  };
}

function pointInZone(pos, zone) {
  return (
    pos.x >= zone.xMin - 1e-6 &&
    pos.x <= zone.xMax + 1e-6 &&
    pos.y >= zone.yMin - 1e-6 &&
    pos.y <= zone.yMax + 1e-6
  );
}

// 座標からエリア名を判定する（優先順: stage → stageLeft → stageRight → upstageBackstage）
function resolveArea(pos, zones) {
  if (pointInZone(pos, zones.stage)) return "stage";
  if (pointInZone(pos, zones.stageLeft)) return "stageLeft";
  if (pointInZone(pos, zones.stageRight)) return "stageRight";
  if (pointInZone(pos, zones.upstageBackstage)) return "upstageBackstage";
  return null;
}

// ステージ本体・袖・舞台奥待機、そのどれにも属さない「さらに外側」に出た場合だけ警告する
function isBeyondAllAreas(pos, zones) {
  return resolveArea(pos, zones) === null;
}

function samePos(a, b) {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
}

// 指定エリアの中央付近に、渡された順番（通常は番号順）で 0.5 単位のグリッドに
// 重ならないよう一列に並べる。
// 待機エリアサイズ最適化（左右袖を縦長・舞台奥を横長にコンパクト化）に合わせ、
// stageLeft/stageRight（縦長の袖）は常に縦1列、upstageBackstage（横長の舞台奥）は
// 常に横1列という固定方向で並べる。stage（ステージ本体）だけは、これまで通り
// 「zoneが横に広ければ横方向、縦に長ければ縦方向」というzone形状による自動判定を維持する
// （ステージ本体の自動整列方向は今回のスコープ外のため）。
// 戻り値は { [id]: { x, y } }（area はここでは決めない＝呼び出し側で確定させる）。
function arrangeInZone(ids, areaKey, zones) {
  const zone = zones[areaKey];
  const positions = {};
  if (!zone || ids.length === 0) return positions;
  const zoneW = zone.xMax - zone.xMin;
  const zoneD = zone.yMax - zone.yMin;
  const cx = (zone.xMin + zone.xMax) / 2;
  const cy = (zone.yMin + zone.yMax) / 2;
  let horizontal;
  if (areaKey === "stageLeft" || areaKey === "stageRight") {
    horizontal = false; // 縦1列固定（PART C・D）
  } else if (areaKey === "upstageBackstage") {
    horizontal = true; // 横1列固定（PART E）
  } else {
    horizontal = zoneW >= zoneD; // stage等：既存のzone形状による自動判定を維持（PART F）
  }
  const n = ids.length;
  ids.forEach((id, i) => {
    const offset = (i - (n - 1) / 2) * 0.5;
    let x = horizontal ? snapHalf(cx + offset) : snapHalf(cx);
    let y = horizontal ? snapHalf(cy) : snapHalf(cy + offset);
    x = clamp(x, zone.xMin, zone.xMax);
    y = clamp(y, zone.yMin, zone.yMax);
    positions[id] = { x, y };
  });
  return positions;
}

// 出演者を新規追加するときの初期配置を決める。「ステージ上」エリアの中央付近を起点に、
// 横方向へ0.5単位ずつ中央→右→左…と広げていき、その行（＝同じ縦位置）がステージ幅の
// 範囲を超えたら次の行（縦位置を0.5単位ずらした行）へ折り返す。既存の出演者と
// 完全に重なる座標は避け、最初に見つかった空き座標を返す。
function findInitialStagePlacement(existingPositions, zones) {
  const zone = zones.stage;
  const centerX = (zone.xMin + zone.xMax) / 2;
  const centerY = (zone.yMin + zone.yMax) / 2;

  const occupied = new Set(existingPositions.map((p) => `${p.x.toFixed(1)}:${p.y.toFixed(1)}`));

  // 中央から左右／前後交互に広がるオフセット列（0, 0.5, -0.5, 1, -1, 1.5, -1.5, …）
  const makeAlternatingOffsets = (span) => {
    const offsets = [0];
    const steps = Math.ceil(span / 0.5) + 2;
    for (let i = 1; i <= steps; i += 1) {
      offsets.push(i * 0.5);
      offsets.push(-i * 0.5);
    }
    return offsets;
  };

  const colOffsets = makeAlternatingOffsets(zone.xMax - zone.xMin);
  const rowOffsets = makeAlternatingOffsets(zone.yMax - zone.yMin);

  for (const dy of rowOffsets) {
    const y = snapHalf(centerY + dy);
    if (y < zone.yMin - 1e-6 || y > zone.yMax + 1e-6) continue;
    for (const dx of colOffsets) {
      const x = snapHalf(centerX + dx);
      if (x < zone.xMin - 1e-6 || x > zone.xMax + 1e-6) continue;
      const key = `${x.toFixed(1)}:${y.toFixed(1)}`;
      if (!occupied.has(key)) {
        return { x, y };
      }
    }
  }
  // 理論上ここには到達しない（ステージ内の0.5単位マスが全て埋まった場合のみ）。
  // 念のため中央へフォールバックする。
  return { x: clamp(centerX, zone.xMin, zone.xMax), y: clamp(centerY, zone.yMin, zone.yMax) };
}

// ------------------------------------------------------------------
// 初期データ
// ------------------------------------------------------------------
function createInitialSlide() {
  return {
    id: makeId("slide"),
    name: "構成 1",
    placements: {}, // { [performerId]: { x, y, area?, pose?, moveFrom?, moveTo?, waypoints?, startTime?, endTime? } }
    // pose（姿勢 v1・新規）："standing" | "kneeling"。未設定（既存Projectのデータ含む）は
    // getPlacementPose()がstandingとして扱う（後方互換・3章）。performer自体の属性ではなく
    // 構成ごとのplacementの属性とすることで、同じ出演者が構成によって立ち/片膝を切り替えられる。
    // keepCounts：「この構成のまま何カウント維持するか」＝構成そのものの属性。
    // transitionCounts（構成と構成の「間」の属性、work直下の別マップ）とは明確に別物にするため、
    // slideオブジェクト自身のプロパティとして持たせる（削除・並べ替え時に自動でslideと一緒に
    // 移動/消滅し、transitionCountsのような隣接関係の再計算が不要になる）。
    keepCounts: DEFAULT_KEEP_COUNTS,
    // musicAnchor（Music Anchor v1・新規）：「この構成が音楽上のどの位置に対応するか」を表す
    // slide自身の属性。keepCountsと同じ考え方で、構成間の関係（transitionCounts/transitionPaths）
    // ではなくslideオブジェクト自身へ持たせる（1〜2章）。絶対秒（音源全体基準の秒数）そのものは
    // 保存せず、常に{ sectionId, eighthNumber, countOffset }から都度計算する（31章：Section BPMや
    // countStartSecを後から変更しても、保存し直しなしで計算結果だけが追従するようにするため）。
    // 未設定（この構成にはまだ音楽上の位置を割り当てていない）はnull（3章）。
    musicAnchor: null,
    // 将来: lights: [] などをスライド単位、または独立レイヤーとして追加可能
  };
}

// 新規作品（work）の初期データを生成する。旧バージョンではApp()内のuseRefで直接組み立てていたが、
// Multi Project化に伴い「新規Project作成」からも同じ初期状態を再利用できるよう関数化した。
// 呼び出すたびに、id等も含めてすべて新規生成する（＝Project間でオブジェクト参照を一切共有しない）。
function createInitialWork() {
  return {
    stage: { width: 20, depth: 10 },
    performers: [],
    slides: [createInitialSlide()],
    currentSlideIndex: 0,
    transitionCounts: {}, // { [移動元スライドのid]: カウント数 }。未設定時はDEFAULT_TRANSITION_COUNTSにフォールバックする
    transitionPaths: {}, // { [移動元スライドのid]: { [performerId]: {type:"linear"} | {type:"curve", waypoint:{x,y}} } }。未設定時は直線にフォールバックする
    project: {
      bpm: DEFAULT_BPM,
      musicSections: [createDefaultMusicSection(DEFAULT_BPM)],
      // musicAsset：このProjectに紐づく音源の「参照情報」だけ（実体はIndexedDB側）。
      // 新規Projectは必ず「音源なし」から始まり、直前に開いていたProjectの音源を
      // 勝手に引き継がない（Project別音源管理v1・6章）。
      musicAsset: null,
      // 出演者表示サイズ v1・PART T：新規Projectのdefaultは「大」。
      performerDisplayScale: PERFORMER_DISPLAY_SCALE_LARGE,
    },
  };
}

// ------------------------------------------------------------------
// Multi Project / Workspace v1
// ------------------------------------------------------------------
// Workspace = 「複数のProject（作品）を束ねる入れ物」。
//   { version, activeProjectId, projects: [{ id, name, createdAt, updatedAt, work }] }
// Projectの中身（work）は、従来からある単一work構造をまったく作り直さず、そのまま
// Project.workとして保持する（stage / performers / slides / transitionCounts /
// transitionPaths / project.bpm / project.musicSections はこれまで通りwork直下）。
const WORKSPACE_VERSION = 1;
const WORKSPACE_STORAGE_KEY = "dance-stage-simulator-workspace-v1";

function createProjectFromWork(work, name) {
  const now = new Date().toISOString();
  return {
    id: makeId("project"),
    name: name || "プロジェクト 1",
    createdAt: now,
    updatedAt: now,
    work,
  };
}

// まっさらな新規Workspace（Project 1件だけを持つ）。localStorageが無い初回起動や、
// 保存データの読み込みに失敗した場合のfallback先として使う。
function createFreshWorkspace() {
  const project = createProjectFromWork(createInitialWork(), "プロジェクト 1");
  return {
    version: WORKSPACE_VERSION,
    activeProjectId: project.id,
    projects: [project],
  };
}

// 保存されたWorkspaceデータ（≒JSON.parse直後の生データ）を検証・補完する。
// 壊れたJSON・古いversion・不完全データが混じっていても、可能な限りprojectsを救い出し、
// 復元不能な場合だけ安全な新規Workspaceへfallbackする（22章）。
function normalizeWorkspace(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.projects) || raw.projects.length === 0) {
    return createFreshWorkspace();
  }
  const validProjects = [];
  raw.projects.forEach((p) => {
    if (!p || typeof p !== "object") return;
    if (!p.work || typeof p.work !== "object") return;
    if (!Array.isArray(p.work.slides) || p.work.slides.length === 0) return;
    const now = new Date().toISOString();
    validProjects.push({
      id: typeof p.id === "string" && p.id ? p.id : makeId("project"),
      name: typeof p.name === "string" && p.name.trim() ? p.name : "名称未設定",
      createdAt: typeof p.createdAt === "string" ? p.createdAt : now,
      updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : now,
      work: p.work,
    });
  });
  if (validProjects.length === 0) return createFreshWorkspace();
  const activeProjectId =
    typeof raw.activeProjectId === "string" && validProjects.some((p) => p.id === raw.activeProjectId)
      ? raw.activeProjectId
      : validProjects[0].id;
  return {
    version: WORKSPACE_VERSION,
    activeProjectId,
    projects: validProjects,
  };
}

// version不一致の場合の移行処理。今回はversion 1のみ存在するため実質何もしないが、
// 将来 version 2 以降を追加する際は、ここへ `if (data.version === 1) { ... }` の形で
// 変換ステップを積み増していける構造にしてある（23章）。
function migrateWorkspace(raw) {
  if (!raw || typeof raw !== "object") return raw;
  if (raw.version === WORKSPACE_VERSION) return raw;
  // 将来のmigration用プレースホルダー。現状はversionを揃えるだけ。
  return { ...raw, version: WORKSPACE_VERSION };
}

// localStorageからWorkspaceを読み込む。壊れたJSON・想定外の形・localStorage自体が
// 使えない環境（プライベートブラウズ等）でも、例外を投げずに安全なWorkspaceを返す。
function loadWorkspace() {
  try {
    if (typeof window === "undefined" || !window.localStorage) return createFreshWorkspace();
    const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) return createFreshWorkspace();
    const parsed = JSON.parse(raw);
    return normalizeWorkspace(migrateWorkspace(parsed));
  } catch (e) {
    return createFreshWorkspace();
  }
}

// WorkspaceをlocalStorageへ保存する。AudioBuffer等のruntimeオブジェクトは元々
// Workspace/Project.work内に一切含まれないため、そのままJSON.stringifyしてよい（17章）。
// 容量超過等でsetItemが失敗してもアプリをクラッシュさせない（21章）。
function saveWorkspace(workspace) {
  try {
    if (typeof window === "undefined" || !window.localStorage) return false;
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
    return true;
  } catch (e) {
    return false;
  }
}

// currentSlideIndexが新しいworkのslides件数に対しても安全な範囲に収まるよう調整する。
// 例：Project Aで構成27を見ていた状態からProject B（5構成）へ切り替えてもクラッシュしない（6章）。
function clampWorkSlideIndex(work) {
  if (!work || !Array.isArray(work.slides) || work.slides.length === 0) return work;
  const maxIndex = work.slides.length - 1;
  const clamped = clamp(work.currentSlideIndex || 0, 0, maxIndex);
  if (clamped === work.currentSlideIndex) return work;
  return { ...work, currentSlideIndex: clamped };
}

// 指定したactiveなProjectのwork参照を、Workspace側（projects[x].work）へ書き戻す。
// 「Project切替のたびに、切替直前のworkが必ずworkspaceへ反映されている」ことを保証するための
// 共通helper。App()内の（a）work変化を監視するuseEffect、（b）switchProject/createNewProject/
// duplicateProject/deleteProjectがactiveProjectIdを書き換える直前、の両方から同じ関数を呼ぶことで、
// 「直前に読み込んだ音源の参照(work.project.musicAsset)がWorkspaceへ反映されないまま
// Projectを切り替えてしまう」という取りこぼしを防ぐ（Project別音源管理v1・29章のSingle Source
// of Truth要件を、Multi Project v1の一方向同期と全く同じ考え方でmusicAssetにも適用する）。
function mergeWorkIntoWorkspace(ws, projectId, currentWork) {
  const idx = ws.projects.findIndex((p) => p.id === projectId);
  if (idx === -1) return ws;
  if (ws.projects[idx].work === currentWork) return ws; // 参照が同じ＝既に最新。無駄な更新をしない
  const nextProjects = ws.projects.slice();
  nextProjects[idx] = { ...nextProjects[idx], work: currentWork, updatedAt: new Date().toISOString() };
  return { ...ws, projects: nextProjects };
}

// 指定したassetIdが、excludeProjectId以外のいずれかのProjectからまだ参照されているかを判定する。
// 参照カウントを別データとして永続化せず、Workspace.projectsをその場で走査する方式（8章の設計）。
// Project削除・音源差し替え・「音楽を外す」のいずれからも、この1つの関数だけを使う
// （「まだ他から参照されているか」の判定ロジックを重複実装しない）。
function isMusicAssetReferencedByAnyProject(workspace, assetId, excludeProjectId) {
  if (!assetId || !workspace || !Array.isArray(workspace.projects)) return false;
  return workspace.projects.some((p) => {
    if (excludeProjectId && p.id === excludeProjectId) return false;
    const asset = getMusicAsset(p.work);
    return asset && asset.id === assetId;
  });
}

// ------------------------------------------------------------------
// Project Backup v1：Project単位のJSON書き出し／読み込み
// ------------------------------------------------------------------
// 目的：現在ブラウザ内（localStorage + IndexedDB）だけに保存されているProjectを、
// 別ブラウザ／別PCへ持ち運べるようにする。書き出す対象はWorkspace全体ではなく、
// あくまで「現在のactive Project 1件だけ」（Workspace全体バックアップは今回のスコープ外）。
// WAV本体（IndexedDB内のBlob）はJSONへは一切含めない。work.project.musicAssetという
// 「参照情報」（{ id, fileName, mimeType }）だけがそのままJSONへ含まれる形になる。
const PROJECT_BACKUP_TYPE = "dance-stage-simulator-project";
const PROJECT_BACKUP_VERSION = 1;

// 現在のactive Projectから、書き出し用のBackup JSON（wrapperごと）を組み立てる。
// duplicateProject()と同じ「JSON.parse(JSON.stringify(...))によるdeep copy」を使うことで、
// workの中にAudioBuffer等のruntimeオブジェクトが混入しないことを保証する
// （workがJSON化可能データのみで構成されているという前提はduplicateProject等と同じ）。
function buildProjectBackup(projectName, work) {
  return {
    backupType: PROJECT_BACKUP_TYPE,
    version: PROJECT_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    project: {
      name: projectName,
      work: JSON.parse(JSON.stringify(work)),
    },
  };
}

// 読み込んだJSON（生データ）を検証・正規化する。読み込んだデータは一切信用せず、
// 最低限の形（backupType / version / project / project.work）を確認したうえで、
// work自体の中身は「Workspace読み込み時と全く同じnormalizeWorkspace()のバリデーション」を
// 再利用する（project 1件だけを含む仮のWorkspaceとして渡す）。別のバリデーションロジックを
// 重複実装しないための設計（既存のp.work.slidesチェック等をそのまま使い回す）。
// 成功時は { ok: true, name, work } を、失敗時は { ok: false, reason } を返す。
function validateProjectBackup(raw) {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "JSONの形式が正しくありませんでした。" };
  }
  if (raw.backupType !== PROJECT_BACKUP_TYPE) {
    return { ok: false, reason: "このファイルはこのアプリのプロジェクトバックアップではないようです。" };
  }
  if (raw.version !== PROJECT_BACKUP_VERSION) {
    return { ok: false, reason: "対応していないバックアップのバージョンです。" };
  }
  if (!raw.project || typeof raw.project !== "object" || !raw.project.work || typeof raw.project.work !== "object") {
    return { ok: false, reason: "プロジェクトデータが見つかりませんでした。" };
  }
  const probeId = "backup-import-probe";
  const fakeWorkspace = {
    version: WORKSPACE_VERSION,
    activeProjectId: probeId,
    projects: [
      {
        id: probeId,
        name: typeof raw.project.name === "string" ? raw.project.name : "",
        work: raw.project.work,
      },
    ],
  };
  // normalizeWorkspace()は検証に失敗すると必ずcreateFreshWorkspace()（新規idのProject）へ
  // fallbackする。probeIdがそのまま残っていれば検証を通過したとみなせる。
  const normalized = normalizeWorkspace(fakeWorkspace);
  const normalizedProject = normalized.projects.find((p) => p.id === probeId);
  if (!normalizedProject) {
    return { ok: false, reason: "プロジェクトデータの形式が正しくありませんでした。" };
  }
  return { ok: true, name: normalizedProject.name, work: normalizedProject.work };
}

// Workspace内の既存Project名と衝突しない名前を作る（15章）。
// 完全一致する名前が無ければそのまま、あれば「(読み込み)」→「(読み込み 2)」…と広げていく。
function buildImportedProjectName(existingProjects, baseNameRaw) {
  const baseName = (typeof baseNameRaw === "string" && baseNameRaw.trim()) || "名称未設定";
  const existingNames = new Set((existingProjects || []).map((p) => p.name));
  if (!existingNames.has(baseName)) return baseName;
  const withSuffix = `${baseName} (読み込み)`;
  if (!existingNames.has(withSuffix)) return withSuffix;
  let n = 2;
  while (existingNames.has(`${baseName} (読み込み ${n})`)) {
    n += 1;
  }
  return `${baseName} (読み込み ${n})`;
}

// ------------------------------------------------------------------
// Project別音源管理 v1：IndexedDBによる音源本体の永続化
// ------------------------------------------------------------------
// 3層構造の②（IndexedDB）を担当する薄いラッパー層。
//   ① Project / Workspace : musicAsset = { id, fileName, mimeType } という「参照情報」のみ保持
//   ② IndexedDB           : musicAssets object store に { id, blob, fileName, mimeType, savedAt } を保持（ここ）
//   ③ Audio Runtime       : App()内のaudioContextRef / audioBufferRef 等（AudioBufferはここへは保存しない）
//
// WAV本体（File / Blob）はlocalStorageへは一切保存せず、IndexedDBだけに保存する（3章）。
// AudioBuffer自体（decode済みデータ）もIndexedDB/localStorageのどちらにも保存しない。
// 常に「Blob（IndexedDB）→ ArrayBuffer → decodeAudioData() → AudioBuffer（runtimeのみ）」という
// 一方向の変換で復元する（3章）。
//
// DB名・object store名は将来のmigrationに備えてバージョン付きで固定化する。
const MUSIC_DB_NAME = "dance-stage-simulator-music-db-v1";
const MUSIC_DB_VERSION = 1;
const MUSIC_STORE_NAME = "musicAssets"; // keyPath: "id"

// IndexedDBが使えない環境（プライベートブラウズ・古いブラウザ・SSR等）でも例外を投げず、
// 呼び出し側（idbPutMusicAsset等）がPromise.reject経由でtry/catchできる形にしてある。
function openMusicDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined" || !indexedDB) {
      reject(new Error("IndexedDB unavailable in this environment"));
      return;
    }
    let req;
    try {
      req = indexedDB.open(MUSIC_DB_NAME, MUSIC_DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(MUSIC_STORE_NAME)) {
        db.createObjectStore(MUSIC_STORE_NAME, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
    req.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

// 音源1件（Blobを含む）をIndexedDBへ保存する。record = { id, blob, fileName, mimeType, savedAt }。
// 失敗（容量超過・DB破損・非対応環境等）してもアプリをクラッシュさせず、falseを返すだけにする
// （15章：保存失敗時もWorkspace/localStorage側は無傷のまま）。
async function idbPutMusicAsset(record) {
  try {
    const db = await openMusicDB();
    return await new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(MUSIC_STORE_NAME, "readwrite");
      } catch (err) {
        reject(err);
        return;
      }
      tx.objectStore(MUSIC_STORE_NAME).put(record);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error("IndexedDB put failed"));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB put aborted"));
    });
  } catch (err) {
    console.error("[MusicDB] idbPutMusicAsset failed", err);
    return false;
  }
}

// 音源1件を取得する。存在しない・取得失敗の場合はnullを返す（例外を投げない）。
async function idbGetMusicAsset(id) {
  if (!id) return null;
  try {
    const db = await openMusicDB();
    return await new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(MUSIC_STORE_NAME, "readonly");
      } catch (err) {
        reject(err);
        return;
      }
      const req = tx.objectStore(MUSIC_STORE_NAME).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error("IndexedDB get failed"));
    });
  } catch (err) {
    console.error("[MusicDB] idbGetMusicAsset failed", err);
    return null;
  }
}

// 音源1件を削除する。他のどのProjectからも参照されなくなった場合にだけ呼ばれる想定
// （呼び出し側でisMusicAssetReferencedByAnyProjectによる判定を必ず済ませておくこと）。
// 失敗してもアプリをクラッシュさせない（単なるゴミデータが残るだけで、動作には影響しない）。
async function idbDeleteMusicAsset(id) {
  if (!id) return false;
  try {
    const db = await openMusicDB();
    return await new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(MUSIC_STORE_NAME, "readwrite");
      } catch (err) {
        reject(err);
        return;
      }
      tx.objectStore(MUSIC_STORE_NAME).delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error("IndexedDB delete failed"));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB delete aborted"));
    });
  } catch (err) {
    console.error("[MusicDB] idbDeleteMusicAsset failed", err);
    return false;
  }
}

// slide.musicAnchorを安全に取得するhelper。getKeepCounts(slide)と全く同じ考え方で、
// musicAnchor機能実装前の古いslide（プロパティ自体が存在しない）でもクラッシュせず、
// 常に「未設定（null）」として扱えるようにする（3章：既存slideにmusicAnchorが無くても安全に）。
function getMusicAnchor(slide) {
  const anchor = slide && slide.musicAnchor;
  if (!anchor || typeof anchor !== "object") return null;
  if (typeof anchor.sectionId !== "string") return null;
  if (typeof anchor.eighthNumber !== "number" || !Number.isFinite(anchor.eighthNumber)) return null;
  const countOffset = typeof anchor.countOffset === "number" && Number.isFinite(anchor.countOffset) ? anchor.countOffset : 0;
  return { sectionId: anchor.sectionId, eighthNumber: Math.max(1, Math.round(anchor.eighthNumber)), countOffset: clamp(Math.round(countOffset), 0, 7) };
}

// ------------------------------------------------------------------
// 再生開始モード v1：slide.musicPlaybackStartMode の safe getter
// ------------------------------------------------------------------
// 手動Music Anchorを持つ構成ごとに、「指定位置から再生」（"anchor"）／「曲頭から再生」
// （"sectionStart"）を選べるようにするための新しいoptional field。
// 既存slide（このfield自体が存在しない）は必ず"anchor"として扱う（後方互換。schema変更は
// このoptional field追加のみで、他のフィールドには一切触れない）。不正な値（想定外の文字列等）が
// 入っていた場合も安全側の"anchor"にfallbackする。
// getKeepCounts・getMusicAnchorと同じ「slide.xxxへの直接判定をコード各所に散らさない」という
// 考え方を踏襲し、以後この関数だけを経由する。
function getMusicPlaybackStartMode(slide) {
  return slide && slide.musicPlaybackStartMode === "sectionStart" ? "sectionStart" : "anchor";
}

// 13〜14章：musicAnchor（sectionId・eighthNumber・countOffset）から、音源全体を基準にした
// 絶対秒を計算するpure helper。Reactや他のUI stateに一切依存しない純粋関数にし（30章：将来、
// 音楽currentTimeを起点にした逆算にも同じ関数を安全に再利用できるようにするため）、
// 既存のcountsToSeconds()をそのまま再利用する（重複ロジックを作らない）。
// 対象Sectionが見つからない（sectionIdが指すSectionが存在しない＝19章の削除直後など）場合はnullを返す。
// 計算に使うBPMは必ずSection自身のbpm（section.bpm）であり、project全体のBPM（projectBpm）とは
// 混同しない（34章）。この関数自体はprojectBpmを一切参照しない（引き続き変更なし）。
// Music Section BPM反映 v1：keep / moveの実時間計算（getEffectiveBpmForSlide経由）も、
// Auto Chainで辿り着いたSectionのbpmを使うようになったため、この関数が返す絶対秒（Anchorの
// 位置）と、実際のアニメーション速度の両方が同じSection BPMを参照する形に揃っている。
function musicAnchorToTimeSec(musicAnchor, musicSections) {
  if (!musicAnchor || !Array.isArray(musicSections)) return null;
  const section = musicSections.find((s) => s.id === musicAnchor.sectionId);
  if (!section) return null;
  const bpm = clampBpm(section.bpm);
  const countStartSec = Number.isFinite(section.countStartSec) ? section.countStartSec : 0;
  const eighthNumber = Math.max(1, Math.round(musicAnchor.eighthNumber));
  const countOffset = clamp(Math.round(musicAnchor.countOffset || 0), 0, 7);
  const totalCountsFromSectionStart = (eighthNumber - 1) * COUNTS_PER_EIGHT + countOffset;
  return countStartSec + countsToSeconds(totalCountsFromSectionStart, bpm);
}

// ------------------------------------------------------------------
// Music Anchor Auto Chain v1：手動Anchor＋keepCounts＋transitionCountsから
// 後続slideの音楽位置を自動計算するpure helper
// ------------------------------------------------------------------
// 目的（今回の基本思想）：すべてのslideへmusicAnchorを手動設定するのではなく、
// 「手動Anchor」→「keepCounts + transitionCounts」→「後続slideの音楽位置を自動計算」という
// 方式にする。自動計算された位置はslide.musicAnchorへは一切保存しない（2章：musicAnchorは
// 常に「ユーザーが明示的に指定した基準点」のみを表す）。
//
// 引数：
//   slides           現在の構成配列（並び順そのまま。並べ替え後も呼び出し側が最新の配列を渡せば
//                     常に新しい順序で再計算される＝25章）
//   slideIndex       位置を知りたい構成のindex
//   musicSections     Music Section配列（現時点の実装では直接は参照しないが、将来のSection境界を
//                     跨いだ自動連鎖・検証等でもこの関数の呼び出し方を変えずに済むよう、
//                     signatureの一部として受け取っておく）
//   transitionCounts  work.transitionCounts（{ [移動元スライドid]: カウント数 }）
//
// アルゴリズム（2〜9章）：
//   1. slides[slideIndex]自身に手動Anchor（getMusicAnchor）があれば、それをそのまま返す
//      （isManual:true）。探索はここで終わる＝直近の手動Anchorという意味で自分自身を含む。
//   2. 無ければ、slideIndexより前方（手前）へ1つずつ遡り、最初に見つかった手動Anchorを
//      「起点（anchorIndex）」とする。見つからなければ、それより前にもAnchorが無いということ
//      なので null を返す（18章：この場合だけ「未設定」として扱う）。
//   3. 起点のAnchorを、Section内の絶対count位置（sectionCount = (eighthNumber-1)*8+countOffset）
//      へ変換する（6章）。
//   4. anchorIndexからslideIndexの直前まで、各構成の「keepCounts（既存getKeepCounts）＋
//      次の構成へのtransitionCounts（既存getTransitionCounts）」を順に加算していく（3〜5章：
//      どちらも既存のフォールバック仕様をそのまま再利用し、二重実装しない）。
//   5. 最終的な累積count位置から、eighthNumber・countOffsetへ戻す（7章）。
//
// 「8章：同一Music Section内だけ自動連鎖」「9章：次の手動Anchorで連鎖をリセット」は、
// この関数自体が「直近の手動Anchor」だけを起点にする（それより前の手動Anchorやsectionは
// 一切参照しない）という探索方法そのもので自動的に満たされる。他のsectionへの自動切替や
// section境界の自動補正（10・11章）はここでは一切行わない（呼び出し側でwarning表示のみ行う）。
//
// 戻り値：{ anchor: { sectionId, eighthNumber, countOffset }, isManual, sourceIndex } または null。
// 39章：構成数は数十〜数百程度を想定しているため、素直な前方/後方ループのO(n)実装で十分とし、
// 追加のキャッシュ・メモ化構造は持たない（呼び出し側でuseMemoする程度に留める）。
function resolveSlideMusicPosition(slides, slideIndex, musicSections, transitionCounts) {
  void musicSections; // 現時点では未使用（将来のSection境界を跨いだ連鎖・検証用にsignatureへ残す）
  if (!Array.isArray(slides) || slideIndex == null || slideIndex < 0 || slideIndex >= slides.length) return null;

  // 1. 自分自身に手動Anchorがあれば、それを最優先でそのまま返す。
  const ownAnchor = getMusicAnchor(slides[slideIndex]);
  if (ownAnchor) {
    return { anchor: ownAnchor, isManual: true, sourceIndex: slideIndex };
  }

  // 2. 前方（手前）へ遡って直近の手動Anchorを探す。
  let anchorIndex = -1;
  let anchor = null;
  for (let i = slideIndex - 1; i >= 0; i--) {
    const a = getMusicAnchor(slides[i]);
    if (a) {
      anchorIndex = i;
      anchor = a;
      break;
    }
  }
  if (anchorIndex < 0) return null; // 18章：前方にも手動Anchorが無ければ計算不能

  // 3. 手動AnchorをSection内の絶対count位置へ変換する（6章）。
  let totalCount = (anchor.eighthNumber - 1) * COUNTS_PER_EIGHT + anchor.countOffset;

  // 4. anchorIndexからslideIndexの直前まで、keepCounts + transitionCountsを順に加算する（3章）。
  //    既存のgetKeepCounts / getTransitionCountsをそのまま再利用し、フォールバック仕様
  //    （keepCounts未設定→DEFAULT_KEEP_COUNTS、transitionCounts未設定→DEFAULT_TRANSITION_COUNTS）も
  //    そのまま踏襲する（4・5章：二重実装しない）。
  for (let i = anchorIndex; i < slideIndex; i++) {
    totalCount += getKeepCounts(slides[i]);
    totalCount += getTransitionCounts(transitionCounts, slides[i].id);
  }

  // 5. 累積count位置からeighthNumber・countOffsetへ戻す（7章）。
  const eighthNumber = Math.floor(totalCount / COUNTS_PER_EIGHT) + 1;
  const countOffset = totalCount - (eighthNumber - 1) * COUNTS_PER_EIGHT;

  return {
    anchor: { sectionId: anchor.sectionId, eighthNumber, countOffset },
    isManual: false,
    sourceIndex: anchorIndex,
  };
}

// ------------------------------------------------------------------
// Music Section BPM反映 v1：keep / moveの実時間計算で使うBPMを決めるpure helper
// ------------------------------------------------------------------
// 目的：構成間移動アニメーション（keep / move phase）の実際の速度と、音楽seekからの逆算
// （resolveTimelineAtMusicTime）の両方で、必ず同じルールでBPMを決定するための共通helper。
// 二重実装を避けるため、「あるslideがどのMusic Sectionに属しているか」の判定は既存の
// resolveSlideMusicPosition()（手動Anchor優先→Auto Chainによる自動計算）をそのまま再利用し、
// ここで新しい「slide→section」対応表やschemaは一切追加しない。
//
// 優先順位：
//   1. slideIndexの実効Music Anchor（resolveSlideMusicPositionの戻り値。手動Anchorがあれば
//      それ、無ければAuto Chainによる自動計算結果）が参照しているMusic Sectionが見つかり、
//      かつそのsection.bpmが有効な正の数値であれば、そのSection BPMを返す（clampBpmで
//      MIN_BPM〜MAX_BPMへ丸める）。
//   2. 上記が得られない場合（Music Anchorが無い・参照先Sectionが見つからない・
//      section.bpmが不正な値）は、常にprojectBpmへfallbackする。これにより、
//      Music Sectionを使わないProject・音源を入れていないProject・BPM機能実装前の
//      古いProjectは、これまで通りProject BPMだけで動作する（後方互換）。
//
// v1運用上の前提（重要）：1つのkeep / move phaseの「途中」でMusic Section境界を跨ぐ使い方は
// 対象外とする。曲が切り替わる地点ではユーザーが構成境界を分ける運用を前提とし、
// 「phase開始時点で属するslideのMusic Section BPMを、そのphase全体へそのまま適用する」という
// 単純なルールのみを実装する。phase内部でのBPM切り替えや、Section境界をまたぐ内部phase分割は
// 行わない（そのような可変BPM処理はv1のスコープ外）。
//
// move phaseのBPMについて：transitionCountsは既存仕様上「移動元（fromSlide）のid」をキーに
// 持つマップ（work.transitionCounts: {[移動元スライドid]: カウント数}＝getTransitionCounts参照）
// であり、「移動元スライド起点の移動時間」として保存されている。この既存の所有関係に合わせ、
// move phaseのBPMも常に移動元（fromSlide＝slideIndex引数）側のSection BPMを使う。呼び出し側は
// keep/moveを問わず「基準となるslideのindex」を渡すだけでよく、keep/moveの区別自体はこの
// 関数の責務に含めない（呼び出し側でkeepならその構成のindex、moveならfromIndexを渡す）。
//
// 引数はresolveSlideMusicPositionと同じ並び＋projectBpmで、既存の呼び出しパターンと揃えてある。
function getEffectiveBpmForSlide(slides, slideIndex, musicSections, transitionCounts, projectBpm) {
  const resolved = resolveSlideMusicPosition(slides, slideIndex, musicSections, transitionCounts);
  if (resolved && resolved.anchor && Array.isArray(musicSections)) {
    const section = musicSections.find((s) => s.id === resolved.anchor.sectionId);
    if (section && typeof section.bpm === "number" && Number.isFinite(section.bpm) && section.bpm > 0) {
      return clampBpm(section.bpm);
    }
  }
  // Music Anchor未設定・参照先Section不明・section.bpm不正のいずれか（fallback）。
  return clampBpm(projectBpm);
}

// ------------------------------------------------------------------
// 再生中の音楽位置表示 v1・STEP5：通常▶/▶▶再生中の仮想音楽絶対秒
// ------------------------------------------------------------------
// 同期再生（syncPlayback.isActive）ではない通常のアニメーション再生中は、音楽が実際には
// 鳴っていないためmusicCurrentTimeを使えない。その代わり、「そのアニメーションが音楽上では
// 今どこに相当するか」という仮想的な絶対秒を、既存のresolve系helper・count→秒変換だけから
// 計算するpure helper。新しいタイムラインエンジンは作らず、single再生・continuous再生の
// どちらもこの1つの関数から計算する（animationState.playbackMode自体は参照しない＝
// phase/fromIndex/toIndex/progressの意味はsingle/continuousで共通のため、二重実装しない）。
//
// 既存の時間軸の考え方（slideのAnchor→keep→transition→次slide）と一致させる：
//   phase==="keep"：fromIndexの有効Music Position（resolveSlideMusicPosition）の絶対秒を
//                    起点に、そのslideのkeepCounts × progress を、そのslideのeffective BPM
//                    （getEffectiveBpmForSlide）で秒へ変換した分を加算する。
//   phase==="move"：起点はfromIndex側の絶対秒（keepと同じ）。そこへ、fromIndexのkeep
//                    区間の全体（100%）の秒数を加算し、さらにfromIndex→toIndexの
//                    transitionCounts × progress を、fromIndex側のeffective BPMで秒へ
//                    変換した分を加算する（Section BPM反映v1のmove phaseと同じく、
//                    移動元＝fromIndex側のBPMを使う）。
// phaseが"keep"/"move"以外（preroll・アイドル等）、または対象slideの音楽位置が計算できない
// 場合はnullを返す。呼び出し側は音楽位置表示だけを非表示にし、アニメーション再生自体は
// 一切止めない（STEP5-D）。
function resolveAnimationPlaybackMusicTimeSec(slides, musicSections, transitionCounts, projectBpm, animationState) {
  if (!animationState) return null;
  if (animationState.phase !== "keep" && animationState.phase !== "move") return null;
  const fromIndex = animationState.fromIndex;
  const fromSlide = fromIndex != null ? slides[fromIndex] : null;
  if (!fromSlide) return null;
  const resolvedPosition = resolveSlideMusicPosition(slides, fromIndex, musicSections, transitionCounts);
  if (!resolvedPosition) return null;
  const anchorTimeSec = musicAnchorToTimeSec(resolvedPosition.anchor, musicSections);
  if (anchorTimeSec == null || !Number.isFinite(anchorTimeSec)) return null;
  const bpm = getEffectiveBpmForSlide(slides, fromIndex, musicSections, transitionCounts, projectBpm);
  const progress = Number.isFinite(animationState.progress) ? clamp(animationState.progress, 0, 1) : 0;
  const keepCounts = getKeepCounts(fromSlide);

  if (animationState.phase === "keep") {
    return anchorTimeSec + countsToSeconds(keepCounts * progress, bpm);
  }

  // phase === "move"：fromIndexのkeep全体（100%）を通り過ぎた後、move分だけprogress比で進む。
  const keepDurationSec = countsToSeconds(keepCounts, bpm);
  const moveCounts = getTransitionCounts(transitionCounts, fromSlide.id);
  const moveElapsedSec = countsToSeconds(moveCounts * progress, bpm);
  return anchorTimeSec + keepDurationSec + moveElapsedSec;
}

// ------------------------------------------------------------------
// 構成一覧 音楽位置表示 v1
// ------------------------------------------------------------------
// 構成一覧カードの2行目「♫ [Section名] [N]エイト目・[M]カウント目」表示用の文字列・スタイル情報を
// 組み立てるだけのpure helper。位置計算そのものは一切行わず、resolveSlideMusicPosition()の
// 結果（{anchor,isManual}または null）をそのまま受け取って整形するだけにする（二重実装しない。
// PART A・2章）。Section名はsectionIdではなくmusicSections経由の.nameを使う（5章）。
// 手動/自動どちらも解決できない場合はisUnset:trueを返し、呼び出し側は「♫ 未設定」を表示する
// （4章：カード footer の行数・高さを全カードで揃えるため、行自体を消すのではなく
// 「未設定」の文言で埋める方式を採用した）。
function formatFormationListMusicLabel(resolved, musicSections) {
  if (!resolved || !resolved.anchor) {
    return { text: "♫ 未設定", isManual: false, isUnset: true };
  }
  const section = Array.isArray(musicSections)
    ? musicSections.find((s) => s.id === resolved.anchor.sectionId) || null
    : null;
  // Section削除直後などmusicSections側に該当が無くなった保険のケース（他画面のwarning表示と
  // 同じ考え方＝データは書き換えず表示だけ安全側に倒す）。
  const sectionName = section ? section.name : "（不明な楽曲）";
  const text = `♫ ${sectionName} ${formatMusicAnchorEighthCountLabel(resolved.anchor.eighthNumber, resolved.anchor.countOffset)}`;
  return { text, isManual: !!resolved.isManual, isUnset: false };
}

// ------------------------------------------------------------------
// Music Timeline / Formation Markers v1
// ------------------------------------------------------------------
// 「音楽のどの位置に、どの構成が対応しているのか」を音楽シークバー上へ視覚化するための
// 表示専用データを、既存データから派生計算するだけのpure helper。新しいタイムライン
// エンジンや、新しい音楽位置計算ロジックは一切作らない（0章・2章・15章）。
//   ・各構成の絶対時刻は、既存のresolveSlideMusicPosition()（Auto Chain込み）と
//     musicAnchorToTimeSec()をそのまま再利用する（二重実装しない）。
//   ・手動Anchorも無く、Auto Chainでも計算できない構成（resolveSlideMusicPositionが
//     nullを返す＝前方に手動Anchorが1つも無い）は、戻り値に含めない（11章：無理に0秒へ
//     置いたり前の構成に重ねたりしない）。
//   ・音源の長さ（musicDuration）が無い、または0以下の場合は空配列を返す（シークバー
//     自体が意味を持たないため）。
//   ・timeSecがmusicDurationを超える（Auto Chainの積み上げがSection内に収まりきらない等）
//     場合は、バー上の位置としてはratioを0〜1にクランプしつつ outOfRange:true を付与する
//     （マーカー自体は消さない＝情報を失わない。UI側で薄く表示する等の判断に使える）。
// React・DOM・runtime state（音楽再生の実体など）には一切依存しない純粋関数。
function buildFormationTimelineMarkers({ slides, musicSections, transitionCounts, projectBpm, musicDuration }) {
  void projectBpm; // 現時点では未使用（keep/transitionのcount→秒変換はresolveSlideMusicPosition内部が
  // Music Anchor自体の絶対秒計算にはsection.bpmのみを使うため直接は参照しないが、将来
  // 「構成と構成の間のどこにいるか」まで表現する拡張のためsignatureへ残しておく＝14章）。
  if (!Array.isArray(slides) || slides.length === 0) return [];
  if (!Number.isFinite(musicDuration) || musicDuration <= 0) return [];
  const markers = [];
  slides.forEach((slide, slideIndex) => {
    const resolved = resolveSlideMusicPosition(slides, slideIndex, musicSections, transitionCounts);
    if (!resolved) return; // Anchor未設定（前方にも手動Anchorが無い）→ タイムラインに表示しない（11章）
    const timeSec = musicAnchorToTimeSec(resolved.anchor, musicSections);
    if (timeSec == null || !Number.isFinite(timeSec) || timeSec < 0) return; // 参照Sectionが見つからない等
    const outOfRange = timeSec > musicDuration;
    const ratio = clamp(timeSec / musicDuration, 0, 1);
    markers.push({
      slideIndex,
      slideId: slide.id,
      timeSec,
      ratio,
      sectionId: resolved.anchor.sectionId,
      isManualAnchor: resolved.isManual,
      eighthNumber: resolved.anchor.eighthNumber,
      countOffset: resolved.anchor.countOffset,
      outOfRange,
    });
  });
  return markers;
}

// Music Sectionの境界（＝そのSectionの音が実際に始まる位置＝startSec。countStartSecでは
// ない＝10章）を、音楽シークバー上の小さな境界マーカーとして表示するための表示専用データ。
// こちらも既存のmusicSections配列から素直に派生させるだけで、新しい永続データは持たない。
function buildMusicSectionBoundaryMarkers(musicSections, musicDuration) {
  if (!Array.isArray(musicSections) || musicSections.length === 0) return [];
  if (!Number.isFinite(musicDuration) || musicDuration <= 0) return [];
  const boundaries = [];
  musicSections.forEach((section, index) => {
    const startSec = Number.isFinite(section.startSec) ? section.startSec : null;
    if (startSec == null || startSec < 0 || startSec > musicDuration) return;
    boundaries.push({
      sectionId: section.id,
      name: section.name || `${index + 1}曲目`,
      timeSec: startSec,
      ratio: clamp(startSec / musicDuration, 0, 1),
    });
  });
  return boundaries;
}

// 17章：Music Anchor UI専用の、小数第1位まで表示する時間フォーマット（例：1:54.0）。
// 既存のformatTime()（構成アニメーション・Music Barの現在時間表示など、他の既存表示で
// 広く使われている「分:秒（整数）」形式）はそのまま変更せず、このためだけの新しい
// pure helperとして追加する。NaN・Infinity・null・undefinedでも例外を投げず安全に返す。
function formatTimePrecise(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00.0";
  const totalTenths = Math.round(seconds * 10);
  const m = Math.floor(totalTenths / 600);
  const remTenths = totalTenths % 600;
  const s = Math.floor(remTenths / 10);
  const tenths = remTenths % 10;
  return `${m}:${String(s).padStart(2, "0")}.${tenths}`;
}

// ------------------------------------------------------------------
// Music Timing v1.5：時刻入力のparse pure helper
// ------------------------------------------------------------------
// 2〜3章：Music Sectionの「開始」「カウント開始」は、内部データとしては従来通り秒数（Number）の
// ままで持つ（データ構造は変更しない）が、UI上の入力は「純粋な秒数」と「分:秒」の両方を
// 受け付ける。React・DOM・他のstateには一切依存しない純粋関数。
//   "94"       → 94
//   "94.5"     → 94.5
//   "1:34"     → 94
//   "1:34.5"   → 94.5
//   "0:03.25"  → 3.25
// 不正入力（空文字・負数・数値として解釈できない文字列・「1:75」のように秒部分が60以上）は
// nullを返す（呼び出し側はnullの場合workを変更せず、元の値の表示へ戻す＝5章）。
function parseTimeInput(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;

  const colonIndex = trimmed.indexOf(":");
  if (colonIndex < 0) {
    // 「94」「94.5」のような単純な秒数。先頭の"-"（負数）や、数値として不正な文字列は弾く。
    if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }

  // 「1:34」「1:34.5」「0:03.25」のような「分:秒」形式。
  const minutesPart = trimmed.slice(0, colonIndex);
  const secondsPart = trimmed.slice(colonIndex + 1);
  if (!/^\d+$/.test(minutesPart)) return null;
  if (!/^\d+(\.\d+)?$/.test(secondsPart)) return null;
  const minutes = Number(minutesPart);
  const seconds = Number(secondsPart);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  if (seconds >= 60) return null; // 「1:75」のように秒部分が0〜59.xxxの範囲外は不正入力扱い（3章）
  return minutes * 60 + seconds;
}

// ------------------------------------------------------------------
// Music Timing v1.5：Sync Playbackのプリロール（イントロ）計算 pure helper
// ------------------------------------------------------------------
// 自動イントロ廃止 v1：Music Section先頭Anchor（1エイト目・1カウント目）であっても特別扱いせず、
// 通常の同期再生は常に「effective Music Anchorの絶対時刻（anchorTimeSec）」から音楽・構成
// アニメーションを同時に開始する。旧仕様（Section先頭Anchorの場合だけsection.startSec〜
// countStartSecを自動プリロール／イントロとして先に鳴らす）は廃止した。
//
// countStartSec・musicAnchorToTimeSec()の内部定義・計算式は無変更（引き続き「1エイト目・
// 1カウント目の絶対秒」を返す）。section.startSecもデータとしては削除せず、Music Section境界・
// シークバー表示・将来の「曲頭から再生」機能等のために残すが、通常の同期再生の開始位置には
// 使わない。
//
// 引数：
//   anchor         effectiveMusicAnchor（{sectionId, eighthNumber, countOffset}）
//   section        anchorが参照しているMusic Sectionのオブジェクト（見つからなければnullを渡す）
//   anchorTimeSec  既存のmusicAnchorToTimeSec(anchor, musicSections)の結果（二重に秒数計算しない
//                  ため、呼び出し側で計算済みの値をそのまま渡してもらう）
// anchor・section引数は今回の変更では関数内では参照しなくなったが、呼び出し元のシグネチャ・
// 呼び出し箇所を変えないため、そのまま残す（不要リファクタはしない方針）。
//
// 戻り値：{ musicStartSec, animationStartSec, prerollSec } または（anchorTimeSecが無効な場合）
// null。
//   musicStartSec     音楽の再生を開始する絶対秒（＝anchorTimeSec）
//   animationStartSec 構成アニメーション（keep/move）を開始する絶対秒（＝anchorTimeSec）
//   prerollSec        常に0（廃止前の名残として構造は残すが、通常の同期再生では絶対に
//                      正の値にならない。PREROLL_ANIMATION_STATE・プリロール完了監視の
//                      useEffect等はseek・過去データ等の別経路のために残すが、この関数からは
//                      もう発火しない）
function getSyncPlaybackTiming(anchor, section, anchorTimeSec) {
  if (anchorTimeSec == null || !Number.isFinite(anchorTimeSec)) return null;
  return { musicStartSec: anchorTimeSec, animationStartSec: anchorTimeSec, prerollSec: 0 };
}

// ------------------------------------------------------------------
// 曲頭再生 v1：「曲頭から再生」timing計算pure helper（再生開始モード v1・STEP3以降は、
// 独立した「曲頭▶」ボタンではなく、構成ごとのmusicPlaybackStartModeから
// resolveMusicPlaybackTimingForSlide経由で呼ばれる）
// ------------------------------------------------------------------
// 通常の♫▶（getSyncPlaybackTiming、常にeffectiveMusicAnchorの絶対時刻へ音楽・アニメーションを
// 同時開始する完成仕様）とは別に、ユーザーが明示的に選んだ場合だけ「そのMusic Sectionの
// startSecから音楽を先行再生し、現在構成のAnchor時刻（anchorTimeSec）に到達したら構成
// アニメーションを開始する」というtimingを計算する。getSyncPlaybackTiming自体は一切変更しない
// （自動イントロには戻さない）。
//
// 基本ルール：
//   musicStartSec     = section.startSec
//   animationStartSec = anchorTimeSec
//   prerollSec        = anchorTimeSec - section.startSec
//
// 曲途中のAnchorでも同じ考え方で使える（1エイト目・1カウント目に限定しない）：
// 「Section startSec → 現在構成のAnchor」まで音楽だけを流し、Anchorへ到達したら
// 現在構成からアニメーションを開始する。
//
// 以下はいずれもnullを返し、安全に失敗する（作品データの自動修正はしない）：
//   ・sectionが無い
//   ・section.startSecが有限数でない
//   ・anchorTimeSecが無効（null/NaN）
//   ・anchorTimeSec < section.startSec（現在構成のAnchorがSection開始より前という不正データ）
function getSectionHeadPlaybackTiming(section, anchorTimeSec) {
  if (!section) return null;
  const startSec = section.startSec;
  if (!Number.isFinite(startSec)) return null;
  if (anchorTimeSec == null || !Number.isFinite(anchorTimeSec)) return null;
  if (anchorTimeSec < startSec) return null;
  const prerollSec = anchorTimeSec - startSec;
  return { musicStartSec: startSec, animationStartSec: anchorTimeSec, prerollSec };
}

// ------------------------------------------------------------------
// 再生開始モード解決 v1：resolveMusicPlaybackTimingForSlide
// ------------------------------------------------------------------
// 「このAnchor境界へ到達したとき、どちらのtiming計算（通常のgetSyncPlaybackTiming／
// 曲頭からのgetSectionHeadPlaybackTiming）を使うか」を判断する、唯一の集約ポイント。
// 直接♫▶（startSyncPlayback）・連続同期再生中の手動Anchor境界（handleManualAnchorBoundary）の
// 両方から、必ずこの関数を経由して呼ぶ。
//
// 現在の仕様（重要・将来変更の可能性あり）：
//   slideが持つ「slide自身の」手動Music Anchor（getMusicAnchorで取得できるもの。Auto Chainに
//   よる自動計算結果ではない）のmusicPlaybackStartModeが"sectionStart"の場合、直接♫▶した場合
//   だけでなく、前の構成から連続同期再生して到達した場合にも、対応Music SectionのstartSecへ
//   絶対的に巻き戻す。この「連続再生中も巻き戻す」という挙動は実機確認後に変更される可能性が
//   あるため、切り替えが必要になった場合はcontext（"direct"｜"continuous"）で分岐を追加する
//   だけで対応できるよう、判断をこの1関数へ集約してある（呼び出し元・他のhelperには一切
//   条件分岐を持たせない）。
//
// 引数：
//   slide          対象slide（musicPlaybackStartModeの参照元。effectiveMusicAnchorが
//                  Auto Chainの自動計算結果であっても、この関数は必ずslide自身の
//                  「手動」Anchorが存在する場合だけsectionStartモードを適用する）
//   anchor         実際にtiming計算へ使うAnchor（{sectionId, eighthNumber, countOffset}）
//   section        anchorが参照しているMusic Sectionのオブジェクト（見つからなければnull）
//   anchorTimeSec  musicAnchorToTimeSec(anchor, musicSections)の結果
//   context        "direct"（直接♫▶）｜"continuous"（連続同期再生中の手動Anchor境界）。
//                  現状はどちらでも同じ判定を行うが、将来この関数内だけで分岐できるように
//                  引数として残す。
//
// 戻り値：getSyncPlaybackTiming／getSectionHeadPlaybackTimingいずれかの{musicStartSec,
// animationStartSec, prerollSec}。sectionStartモードでも、getSectionHeadPlaybackTimingが
// 不正データでnullを返した場合（9章：Section無し・startSec不正・anchorTimeSec不正・
// anchorTimeSec<startSec）は、作品データを自動修正せず、安全側で通常のanchor再生へ
// fallbackする。
function resolveMusicPlaybackTimingForSlide(slide, anchor, section, anchorTimeSec, context) {
  void context; // 現状は"direct"・"continuous"どちらも同じ判定（将来ここで分岐を追加する）。
  const hasOwnManualAnchor = !!getMusicAnchor(slide);
  const mode = hasOwnManualAnchor ? getMusicPlaybackStartMode(slide) : "anchor";
  if (mode === "sectionStart") {
    const sectionStartTiming = getSectionHeadPlaybackTiming(section, anchorTimeSec);
    if (sectionStartTiming) return sectionStartTiming;
  }
  return getSyncPlaybackTiming(anchor, section, anchorTimeSec);
}

// ------------------------------------------------------------------
// Music Seek → Formation Reverse Mapping v1
// ------------------------------------------------------------------
// 音楽の絶対時刻（timeSec）から、対応する「構成・keep中/move中・そのフェーズ内progress」を
// 逆算するpure helper。React state・runtime ref等には一切依存しない純粋関数にし（40章：
// 将来のリアルタイムseek・波形クリック・musicCurrentTime完全Single Source of Truth化・
// 曲全体タイムライン・Exportにもそのまま再利用できるようにするため）。
//
// 6〜9章：「実データとしてのslide.musicAnchor（getMusicAnchor）」を持つ構成だけを、
// 時間軸の絶対的な区切り（境界）として扱う。Sync Playback v1.6/v1.7で確立した
// 「手動Anchor＝絶対的な同期境界」という仕様を、逆算でもそのまま踏襲する
// （resolveSlideMusicPositionのようなAuto Chainの自動計算結果＝effectiveMusicAnchorは
// 境界の判定には一切使わない）。
//
// アルゴリズム：
//   1. slides配列を先頭から走査し、手動Anchorを持つslideのindexを順番に集める
//      （＝「手動Anchor区間」の開始点一覧）。1つも無ければ found:false。
//   2. 各区間の「絶対的な開始境界」を求める。区間の先頭Anchorが該当Sectionの先頭
//      （1エイト目・1カウント目）を指す場合は、そのSectionのstartSec（＝28章のpreroll区間の先頭）
//      まで区間の開始を前倒しする。それ以外は既存musicAnchorToTimeSec()の結果そのもの
//      （9章：秒数計算を二重実装しない）。
//   3. timeSecが属する区間を探す。ある区間の終わりは「次の区間の開始境界」まで
//      （32章）。これにより、31章の「前区間のAuto Chain想定終了時刻と次の手動Anchorが
//      重なる」ケースでも、手動Anchor側（次の区間）が自動的に優先され、前区間は
//      その開始境界で強制的に打ち切られる。
//   4. 区間内でtimeSecがそのSectionのstartSec〜countStartSec（＝anchorTimeSec）の間にあれば
//      preroll（28章）。それ以外は、区間の先頭slideから順にkeepCounts→transitionCounts→
//      keepCounts→…と、各phaseが属するslideのMusic Section BPM（Section BPM反映 v1・
//      getEffectiveBpmForSlide経由。Sectionが特定できない場合だけprojectBpmへfallback）で
//      実時間へ変換しながら積み上げ（10〜13章）、timeSecが収まるkeep/moveフェーズを見つける
//      （14・15章）。
//   5. 区間内のどのkeep/moveにも収まらなかった場合（＝部分制作でまだ作っていない空白、
//      または最後のslideのkeep終了後）は、前後の構成へ自動吸着せず found:false を返す
//      （29・30・33章）。
//
// Section BPM反映 v1：順方向の実再生（runPhase呼び出し元）と、この逆算の両方が
// getEffectiveBpmForSlide()という同じ1つのhelperを通してBPMを決定するため、
// 「再生では132BPMで進んだのに、seekで戻すと128BPM換算の位置になる」といった
// 順方向・逆方向の食い違いが起きない。v1では1つのkeep/move phaseの途中でMusic Section
// 境界を跨ぐ運用は対象外（曲を跨ぐ地点は構成境界を分ける運用を前提とする）。
//
// 引数：
//   timeSec           音楽の絶対秒（音源全体基準）。0〜duration範囲へのclampは呼び出し側で行う（34章）。
//   slides            work.slides
//   musicSections     work.project.musicSections（getMusicSections(work)経由で取得済みのもの）
//   transitionCounts  work.transitionCounts
//   projectBpm        getProjectBpm(work)。Music Sectionが特定できないphaseのBPM fallbackとして
//                      getEffectiveBpmForSlideへそのまま渡す（Section未設定Project・音源なし
//                      Projectの従来動作を維持するため）。
//
// 戻り値（found:trueの場合）：
//   { found:true, phase:"preroll", slideIndex, sectionId, anchorTimeSec }
//   { found:true, phase:"keep", slideIndex, progress, elapsedCountsInPhase, totalCountsInPhase, sectionId }
//   { found:true, phase:"move", slideIndex, toSlideIndex, progress, elapsedCountsInPhase, totalCountsInPhase, sectionId }
// 戻り値（found:falseの場合）：
//   { found:false, reason: "invalid-input" | "no-manual-anchor" | "invalid-anchor" | "no-formation-range" }
//
// 41章：構成数は数十〜数百程度を想定しているため、素直な前方走査のO(n)実装のみとし、
// interval tree等の追加インデックス構造は導入しない。
function resolveTimelineAtMusicTime({ timeSec, slides, musicSections, transitionCounts, projectBpm }) {
  if (!Number.isFinite(timeSec) || !Array.isArray(slides) || slides.length === 0) {
    return { found: false, reason: "invalid-input" };
  }

  // 1. 手動Anchorを持つslideのindexを順番に集める。
  const manualIndices = [];
  for (let i = 0; i < slides.length; i++) {
    if (getMusicAnchor(slides[i])) manualIndices.push(i);
  }
  if (manualIndices.length === 0) {
    return { found: false, reason: "no-manual-anchor" };
  }

  // 2. 各区間の絶対開始境界（rangeStartSec）を求める。
  const segments = manualIndices.map((slideIndex) => {
    const anchor = getMusicAnchor(slides[slideIndex]);
    const anchorTimeSec = musicAnchorToTimeSec(anchor, musicSections);
    const section = Array.isArray(musicSections) ? musicSections.find((s) => s.id === anchor.sectionId) || null : null;
    const isSectionHead = anchor.eighthNumber === 1 && anchor.countOffset === 0;
    let rangeStartSec = anchorTimeSec;
    if (isSectionHead && section && Number.isFinite(section.startSec) && Number.isFinite(anchorTimeSec)) {
      // 13章のcountStartSec<startSecのような不正なSection設定でも、区間が
      // 「開始>終了」の矛盾した範囲にならないよう安全側でMath.minを取る。
      rangeStartSec = Math.min(section.startSec, anchorTimeSec);
    }
    return { slideIndex, anchor, anchorTimeSec, section, isSectionHead, rangeStartSec };
  });
  if (segments.some((s) => s.anchorTimeSec == null)) {
    return { found: false, reason: "invalid-anchor" };
  }

  // 3. timeSecが属する区間を探す（32章：次区間の開始境界までが今の区間の範囲）。
  let segIndex = -1;
  for (let i = 0; i < segments.length; i++) {
    const startBound = segments[i].rangeStartSec;
    const endBound = i + 1 < segments.length ? segments[i + 1].rangeStartSec : Infinity;
    if (timeSec >= startBound && timeSec < endBound) {
      segIndex = i;
      break;
    }
  }
  if (segIndex < 0) {
    return { found: false, reason: "no-formation-range" };
  }

  const seg = segments[segIndex];
  const segEndSlideIndexExclusive = segIndex + 1 < segments.length ? segments[segIndex + 1].slideIndex : slides.length;

  // 4. preroll判定（28章）：Section先頭Anchorで、timeSecがanchorTimeSec（countStartSec相当）未満。
  if (seg.isSectionHead && timeSec < seg.anchorTimeSec) {
    return {
      found: true,
      phase: "preroll",
      slideIndex: seg.slideIndex,
      sectionId: seg.anchor.sectionId,
      anchorTimeSec: seg.anchorTimeSec,
    };
  }

  // 5. 区間先頭slideのkeep開始時刻から、keep→move→keep→…と積み上げてtimeSecの位置を探す。
  // Section BPM反映 v1：各phaseのBPMはgetEffectiveBpmForSlide()で決定する（順再生と同じhelper
  // ＝12・19章で報告した「順再生・逆算でBPM決定ルールを共有する」要件）。v1では1つのphaseの
  // 途中でSection境界を跨ぐ運用は対象外のため、phase開始時点のslide（keepはそのslide自身、
  // moveは移動元＝idx側）のBPMをphase全体へそのまま適用する。
  let cursor = seg.anchorTimeSec;
  for (let idx = seg.slideIndex; idx < segEndSlideIndexExclusive; idx++) {
    const keepCounts = getKeepCounts(slides[idx]);
    const keepBpm = getEffectiveBpmForSlide(slides, idx, musicSections, transitionCounts, projectBpm);
    const keepDurSec = countsToSeconds(keepCounts, keepBpm);
    if (keepDurSec > 0 && timeSec < cursor + keepDurSec) {
      const progress = clamp((timeSec - cursor) / keepDurSec, 0, 1);
      return {
        found: true,
        phase: "keep",
        slideIndex: idx,
        progress,
        elapsedCountsInPhase: progress * keepCounts,
        totalCountsInPhase: keepCounts,
        sectionId: seg.anchor.sectionId,
      };
    }
    cursor += keepDurSec;

    const hasNextInSegment = idx + 1 < segEndSlideIndexExclusive;
    if (!hasNextInSegment) break; // 33章：区間内に次の構成が無ければmoveは発生しない

    const moveCounts = getTransitionCounts(transitionCounts, slides[idx].id);
    // move phaseのBPMは移動元（fromSlide＝idx）側のSection BPMを使う。transitionCountsが
    // 「移動元スライドid」をキーに持つ既存の所有関係（getTransitionCounts参照）と揃えてある。
    const moveBpm = getEffectiveBpmForSlide(slides, idx, musicSections, transitionCounts, projectBpm);
    const moveDurSec = countsToSeconds(moveCounts, moveBpm);
    if (moveDurSec > 0 && timeSec < cursor + moveDurSec) {
      const progress = clamp((timeSec - cursor) / moveDurSec, 0, 1);
      return {
        found: true,
        phase: "move",
        slideIndex: idx,
        toSlideIndex: idx + 1,
        progress,
        elapsedCountsInPhase: progress * moveCounts,
        totalCountsInPhase: moveCounts,
        sectionId: seg.anchor.sectionId,
      };
    }
    cursor += moveDurSec;
  }

  // 6. どのkeep/moveにも収まらなかった＝部分制作でまだ作っていない空白（29・30章）。
  //    前後の構成へは自動吸着しない。
  return { found: false, reason: "no-formation-range" };
}

// Music Anchor v1：eighthNumber・countOffsetの入力範囲。
const MIN_MUSIC_ANCHOR_EIGHTH = 1; // 10章：最低1エイト、0エイト目は作らない
const MAX_MUSIC_ANCHOR_EIGHTH = 9999; // 仕様上の明示的な上限は無いが、暴走入力を防ぐための安全ガード
const MIN_MUSIC_ANCHOR_COUNT_OFFSET = 0;
const MAX_MUSIC_ANCHOR_COUNT_OFFSET = 7; // 12章：8以上にはせず0〜7に制限する（繰り上がりはUI側で作らない）

// ------------------------------------------------------------------
// Music Anchorカウント表示 1〜8化 v1
// ------------------------------------------------------------------
// 内部のcountOffset（0〜7。musicAnchorToTimeSec・timeSecToSectionPosition・
// resolveSlideMusicPosition・Auto Chain・Reverse Mapping等、内部計算のすべてがこの0〜7表現を
// 前提にしている）は一切変更しない。ユーザー向け表示・UI入力だけを「1カウント目〜8カウント目」
// （＝1〜8）へ変換するための、表示専用のpure helperをこの1か所へ集約する。
//   displayCount = countOffset + 1
function musicAnchorCountOffsetToDisplayCount(countOffset) {
  return countOffset + 1;
}
function musicAnchorDisplayCountToOffset(displayCount) {
  return displayCount - 1;
}
// 「Nエイト目・Mカウント目」という、ユーザー向け表示で繰り返し使う定型文字列を1か所へ集約する
// （構成一覧カード・Export・Music Timelineマーカー・右サイドバー音楽位置の絶対時間補助表示で
// 共通して使う）。
function formatMusicAnchorEighthCountLabel(eighthNumber, countOffset) {
  return `${eighthNumber}エイト目・${musicAnchorCountOffsetToDisplayCount(countOffset)}カウント目`;
}

// ------------------------------------------------------------------
// 構成（スライド）の命名ヘルパー
// ------------------------------------------------------------------
// 「構成 N」という名前のうち既存の最大Nを探し、+1した名前を返す（「＋ 新しい構成」用）。
// 表示番号（01, 02…＝配列の並び順）とは別物なので、途中に挿入しても数字が飛ぶことがあるが、
// 仕様上「名前の数字と表示番号が必ず一致する必要はない」ため問題ない。
function nextAutoSlideName(slides) {
  let maxNum = 0;
  slides.forEach((s) => {
    const m = /^構成\s*(\d+)$/.exec(s.name || "");
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n) && n > maxNum) maxNum = n;
    }
  });
  return `構成 ${maxNum + 1}`;
}

// ------------------------------------------------------------------
// 構成間の移動カウント（transitionCounts）
// ------------------------------------------------------------------
// 「構成Aから構成Bへの移動時間」は、構成（Slide）そのものの属性ではなく、
// 「AからBへの遷移」という別の概念として扱いたいため、slidesの形（{id, name, placements}）は
// 一切変更せず、work直下に独立したマップとして持たせる。
//   work.transitionCounts: { [移動元スライドのid]: カウント数 }
// 遷移は常に「配列内で隣り合う次のスライド」への移動を指すため、キーは移動元スライドの
// idだけで一意に定まる（移動先idまでは持たない）。将来、非隣接の遷移や複数経路が
// 必要になった場合は、キーを `${fromId}_${toId}` 形式へ拡張するだけで対応できる。
function getTransitionCounts(transitionCounts, fromSlideId) {
  const v = transitionCounts && transitionCounts[fromSlideId];
  return typeof v === "number" && v >= MIN_TRANSITION_COUNTS ? v : DEFAULT_TRANSITION_COUNTS;
}

// keepCounts（構成そのものの属性）の取得ヘルパー。getTransitionCountsと全く同じ考え方で、
// 「slideに明示的に保存されている値があればそれを最優先し、無ければDEFAULT_KEEP_COUNTSへ
// フォールバックする」。sidebar UIの表示・編集と、連続再生エンジンの両方から共通で使い、
// 換算・フォールバックロジックを二重実装しないようにする。
function getKeepCounts(slide) {
  const v = slide && slide.keepCounts;
  return typeof v === "number" && v >= MIN_KEEP_COUNTS ? v : DEFAULT_KEEP_COUNTS;
}

// ------------------------------------------------------------------
// 姿勢 v1：立ち／片膝立ち
// ------------------------------------------------------------------
// 姿勢（pose）はperformer自体の固定属性ではなく、「構成（slide）ごとのplacement」の属性として
// 持たせる（同じ出演者でも構成によって立ち／片膝を切り替えたいという要件のため）。
// 既存Projectのplacementにはposeフィールドが存在しないため、getKeepCounts/getTransitionCounts
// と全く同じ考え方の後方互換ヘルパーを用意し、「値が無ければstanding」という最小限の
// フォールバックだけで扱う（schema migrationは追加しない）。
const POSE_STANDING = "standing";
const POSE_KNEELING = "kneeling";
function getPlacementPose(placement) {
  return placement && placement.pose === POSE_KNEELING ? POSE_KNEELING : POSE_STANDING;
}

// ------------------------------------------------------------------
// 出演者名 v1：任意の補助情報（番号に代わる主情報ではない）
// ------------------------------------------------------------------
// performer.nameはstring・省略可。既存Projectのperformerにはnameフィールドが存在しないため、
// getPlacementPose等と同じ考え方の後方互換ヘルパーを用意し、「値が無ければ空文字」という
// 最小限のフォールバックだけで扱う（schema migrationは追加しない）。
function getPerformerName(performer) {
  return performer && typeof performer.name === "string" ? performer.name : "";
}

// 16章：長い名前でレイアウトが崩れないよう、表示直前に安全な長さへ省略する。
// 日本語5〜8文字程度はそのまま読めることを優先し、それを超える場合だけ末尾を省略する。
// v1.1・PART S：入力欄自体は5文字までに制限したが（PERFORMER_NAME_INPUT_MAX_CHARS）、
// 既存Projectにはmigration前の6文字以上のnameが残っている可能性があるため、表示側の
// 安全策としてこの10文字上限は維持する（データそのものは一切切り詰めない）。
const PERFORMER_NAME_DISPLAY_MAX_CHARS = 10;
function truncatePerformerNameForDisplay(name, maxChars = PERFORMER_NAME_DISPLAY_MAX_CHARS) {
  if (!name) return "";
  if (name.length <= maxChars) return name;
  return `${name.slice(0, maxChars)}…`;
}

// 出演者名 v1.1：新規入力・編集時の最大文字数（PART B）。既存の6文字以上データは
// 強制migrationしない＝入力欄のmaxLengthとしてのみ機能し、既存performer.nameの値そのものは
// 一切書き換えない。
const PERFORMER_NAME_INPUT_MAX_CHARS = 5;

// 出演者名 v1.1・PART E：SVG（編集画面のTopView）とCanvas（renderTopFormationExport＝PNG/ZIP/PDF）
// の両方が同じ計算元を使うpure helper。「マーカー半径figureRadiusに対する比率」で
// fontSize・Y offsetを決めることで、SVGとCanvasで解像度・zoomが違っても、
// 見た目の相対サイズ・相対距離が一致するようにする（PART F）。
//   PERFORMER_NAME_BASE_FONT_RATIO … 1〜4文字時のfontSize ÷ figureRadius。
//     従来のSVG側固定値（fontSize=11, figureRadius≈25.2）とほぼ同じ見た目になる比率
//     （PART C：1〜4文字までは現行の基本サイズを維持する）。
//   PERFORMER_NAME_LONG_FONT_SCALE … 5文字（以上）の場合だけ基本fontSizeに掛ける縮小率。
//     日本語フォントはほぼ等幅のため、4文字→5文字の横幅比とほぼ一致する80%を採用（PART D）。
//   PERFORMER_NAME_OFFSET_Y_RATIO … マーカー下端からのY offset ÷ figureRadius。
//     従来のSVG側固定値（figureRadius+13）とほぼ同じ位置になる比率。
//
// 戻り値offsetYの意味（v1.4・PART I明確化）：「マーカー中心（0,0）から、名前テキストの
// SVGデフォルトbaseline（alphabetic）が来る位置までの距離」。編集画面SVGの<text>は
// dominantBaselineを指定せず、SVGのデフォルトであるalphabetic baselineのまま描画する
// （これを今回の正＝基準とする）。Canvas側はctx.textBaseline="alphabetic"を必ず使うことで、
// SVGのデフォルト挙動と同じ意味でoffsetYを解釈する（PART F〜H：以前はCanvas側が
// textBaseline="top"になっており、SVG側のalphabetic基準と約1文字分弱ズレていた。
// 番号側（drawTopPerformerMarker等）はSVG・Canvasとも元々"middle"で統一されているため、
// そちらは変更していない＝名前描画だけがこのズレの対象だった）。
const PERFORMER_NAME_BASE_FONT_RATIO = 0.44;
const PERFORMER_NAME_LONG_FONT_SCALE = 0.8;
const PERFORMER_NAME_OFFSET_Y_RATIO = 0.52;
function getPerformerNameDisplayMetrics(name, figureRadius, offsetRadius) {
  const text = truncatePerformerNameForDisplay(name || "");
  if (!text) return null;
  const baseFontSize = figureRadius * PERFORMER_NAME_BASE_FONT_RATIO;
  const fontSize = text.length >= 5 ? baseFontSize * PERFORMER_NAME_LONG_FONT_SCALE : baseFontSize;
  // 出演者表示サイズ v1・PART I：offsetRadius（省略時はfigureRadiusにフォールバック＝
  // 従来通りの後方互換）を別に受け取れるようにした。マーカーが小さくなった場合でも
  // 名前のfontSizeは（呼び出し側がgetPerformerNameScale()由来の緩やかな値をfigureRadiusへ
  // 反映するだけなので）大きく縮めずに済む一方、名前とマーカーの縦距離（offsetY）は
  // 実際に縮んだマーカー半径を基準にすることで、小さくなった丸との距離を自然に詰める。
  const offsetBase = offsetRadius != null ? offsetRadius : figureRadius;
  const offsetY = offsetBase + offsetBase * PERFORMER_NAME_OFFSET_Y_RATIO;
  return { text, fontSize, offsetY };
}

// 構成の追加・削除・並べ替えの後で呼び出す。変更前(oldSlides)と変更後(newSlides)を比較し、
// 「移動元→移動先」の隣接ペアが1件も変化していない遷移だけ既存のカウントを引き継ぎ、
// ペアが変わってしまった（＝対応関係が明確でなくなった）箇所は値を持たせない
// （＝参照時に getTransitionCounts が既定値（DEFAULT_TRANSITION_COUNTS）へフォールバックする）。
// 複雑な自動引き継ぎは行わず、「安全でシンプルな挙動」を優先する。
function reconcileTransitionCounts(transitionCounts, oldSlides, newSlides) {
  const oldNextId = new Map();
  for (let i = 0; i < oldSlides.length - 1; i += 1) {
    oldNextId.set(oldSlides[i].id, oldSlides[i + 1].id);
  }
  const next = {};
  for (let i = 0; i < newSlides.length - 1; i += 1) {
    const fromId = newSlides[i].id;
    const toId = newSlides[i + 1].id;
    if (
      oldNextId.get(fromId) === toId &&
      transitionCounts &&
      Object.prototype.hasOwnProperty.call(transitionCounts, fromId)
    ) {
      next[fromId] = transitionCounts[fromId];
    }
  }
  return next;
}

// 構成一覧v2・第2段階①：「あるslideのdeep copyを、指定したafterIndexの直後へ挿入する」という、
// duplicateSlideAt・pasteCopiedSlide（Ctrl+C/Ctrl+V）・pasteSlideAfterIndex（構成一覧の
// 「ここに貼り付け」）の3箇所で全く同じ形をしていた変換を、1つのpure関数へ切り出したもの
// （21章：同じ意味の複製処理を2〜3種類作らない）。
//   ・deepCopyPlainObject＋新規id発行（構成名・placements・keepCounts・musicAnchorは
//     slideオブジェクトごとまとめて複製される＝6・7章）
//   ・reconcileTransitionCounts/reconcileTransitionPaths（8・9章：新しく生まれた隣接ペアには
//     旧いtransitionCounts/transitionPathsを一切引き継がせず、変化していないペアだけを維持する）
// を1箇所にまとめ、以後この関数を経由するどの操作（複製・キーボード貼り付け・構成一覧の
// 貼り付け）でも同じ安全な複製ルールが保証される。currentSlideIndexの決め方は呼び出し元ごとに
// 方針が異なる（duplicateSlideAt/pasteSlideAfterIndexは「追従のみ」、pasteCopiedSlideは
// 「常に新しいslideへジャンプ」）ため、ここでは扱わず、戻り値のnewSlideIdを使って
// 呼び出し側で決定する。副作用は一切持たない（commitWorkのupdater内から呼ばれる前提）。
function insertSlideCopyAfter(prevSlides, prevTransitionCounts, prevTransitionPaths, sourceSlide, afterIndex) {
  const newSlide = { ...deepCopyPlainObject(sourceSlide), id: makeId("slide") };
  const insertAt = afterIndex + 1;
  const nextSlides = [...prevSlides.slice(0, insertAt), newSlide, ...prevSlides.slice(insertAt)];
  const nextTransitionCounts = reconcileTransitionCounts(prevTransitionCounts, prevSlides, nextSlides);
  const nextTransitionPaths = reconcileTransitionPaths(prevTransitionPaths, prevSlides, nextSlides);
  return { nextSlides, nextTransitionCounts, nextTransitionPaths, newSlideId: newSlide.id };
}

// ------------------------------------------------------------------
// Project間構成コピー v1：出演者対応付け・placements変換
// ------------------------------------------------------------------
// Ctrl+C/Ctrl+Vの内部clipboard（copiedSlideRef）を、コピー元Projectとは異なるProjectへ
// 貼り付ける場合だけ使うpure helper群。同一Project内のコピー/貼り付け（insertSlideCopyAfter・
// pasteCopiedSlideの同一Project分岐）は一切変更せず、Project間の場合だけこれらを経由して
// 変換した「slideと同じ形のオブジェクト」をinsertSlideCopyAfter()へ渡す（schemaは変更しない。
// 新しいslide.id発行・transitionCounts/transitionPathsのreconcileは既存のinsertSlideCopyAfter
// にそのまま任せ、二重実装しない）。
//
// 出演者の対応付けは number（数値として比較） と name（前後空白除去のみ、大文字小文字・
// 全角半角等の高度な正規化は行わない）の両方が一致した場合だけ同一人物として扱う。
// 片方だけの一致は対象外とする。
function performerCrossProjectKeysMatch(sourceInfo, targetPerformer) {
  if (!sourceInfo || !targetPerformer) return false;
  const srcNumber = Number(sourceInfo.number);
  const tgtNumber = Number(targetPerformer.number);
  if (!Number.isFinite(srcNumber) || !Number.isFinite(tgtNumber) || srcNumber !== tgtNumber) return false;
  const srcName = String(sourceInfo.name ?? "").trim();
  const tgtName = String(targetPerformer.name ?? "").trim();
  return srcName === tgtName;
}

// コピー元slideのplacementsが実際に参照しているperformerId（＝そのslideに配置がある出演者）
// だけを対象に、sourcePerformersSnapshot（コピー時点のid/number/nameスナップショット）と
// 貼り付け先の現在のperformersをnumber+nameで対応付ける。
//   matchedMap                : Map<コピー元performerId, 貼り付け先performerId>（一致した分だけ）
//   unmatchedSourcePerformers : 一致しなかった出演者の{id, number, name}配列
//     （貼り付け前の警告UI表示用。placementsを持たない出演者はそもそも対象に含めない）
function buildCrossProjectPerformerMapping(sourceSlide, sourcePerformersSnapshot, targetPerformers) {
  const placementIds = Object.keys((sourceSlide && sourceSlide.placements) || {});
  const snapshotById = new Map();
  (Array.isArray(sourcePerformersSnapshot) ? sourcePerformersSnapshot : []).forEach((sp) => {
    if (sp && typeof sp.id === "string") snapshotById.set(sp.id, sp);
  });
  const targets = Array.isArray(targetPerformers) ? targetPerformers : [];
  const matchedMap = new Map();
  const unmatchedSourcePerformers = [];
  placementIds.forEach((sourcePerformerId) => {
    const sourceInfo = snapshotById.get(sourcePerformerId);
    if (!sourceInfo) return; // スナップショットに無い（通常は起きないが保険）→対応不可・警告対象にもしない
    const target = targets.find((tp) => performerCrossProjectKeysMatch(sourceInfo, tp));
    if (target) {
      matchedMap.set(sourcePerformerId, target.id);
    } else {
      unmatchedSourcePerformers.push(sourceInfo);
    }
  });
  return { matchedMap, unmatchedSourcePerformers };
}

// コピー元slideをdeep copyした上で、placementsのキー（performerId）だけを対応表に従って
// 貼り付け先のperformerIdへ変換する。placement schemaを再構築せず、既存のplacementオブジェクト
// （x/y/area/pose等、現在存在する全field）はそのままdeep copyで維持し、キーだけ差し替える。
// 対応が取れなかった出演者のplacementは除外する（＝「そのまま貼り付ける」を選んだ場合の挙動）。
// musicAnchorはProject間コピーの場合だけnullにする（コピー元ProjectのsectionIdを貼り付け先へ
// 持ち込まない。同一Project内コピーはこの関数を通らないため無関係）。
// 再生開始モード v1・STEP11：musicPlaybackStartModeも同じ理由で"anchor"へリセットする
// （コピー元Projectの「曲頭から」設定だけが貼り付け先へ残ると、参照先のmusicAnchor自体は
// nullなのに設定だけが残る、という不整合な状態になるため）。この関数は単体Project間コピー・
// 複数構成一括コピー（Project間の場合）の両方から共通で使われるため、ここで一括して扱う。
// slide.id自体はここでは発行しない。呼び出し側がこの戻り値をinsertSlideCopyAfter()へ渡すことで、
// 既存の新規id発行・transitionCounts/transitionPaths reconcileロジックをそのまま再利用する。
function translateSlideForCrossProjectPaste(sourceSlide, performerIdMap) {
  const copied = deepCopyPlainObject(sourceSlide);
  const nextPlacements = {};
  Object.keys(copied.placements || {}).forEach((sourcePerformerId) => {
    const targetPerformerId = performerIdMap.get(sourcePerformerId);
    if (!targetPerformerId) return;
    nextPlacements[targetPerformerId] = copied.placements[sourcePerformerId];
  });
  return { ...copied, placements: nextPlacements, musicAnchor: null, musicPlaybackStartMode: "anchor" };
}

// ------------------------------------------------------------------
// 複数構成一括コピー v1：出演者mapping（複数slide版）・内部transition判定・bulk挿入
// ------------------------------------------------------------------
// 構成一覧で複数選択したslide群を、同一Project内／Project間を問わず一括で貼り付けるための
// pure helper群。既存の単体用helper（buildCrossProjectPerformerMapping・
// translateSlideForCrossProjectPaste・insertSlideCopyAfter）は一切変更せず、そのまま残す。

// 元Projectのslides配列（allSlides）上で、「選択されたslide同士が直接隣接しているペア」だけを
// 抽出するpure helper。判定は「slides配列で隣り合う2枚が、両方ともselectedIdSetに含まれるか」
// だけで行い、選択した順序や、非連続選択で間に未選択slideが挟まっているかどうかには依存しない。
// これにより、例えば3・4・7を選択した場合、3→4は含まれるが4→7（元Projectで隣接していない）は
// 含まれない、という確定仕様をそのまま満たす。
function findAdjacentSelectedSlidePairs(allSlides, selectedIdSet) {
  const pairs = [];
  for (let i = 0; i < allSlides.length - 1; i++) {
    const fromId = allSlides[i].id;
    const toId = allSlides[i + 1].id;
    if (selectedIdSet.has(fromId) && selectedIdSet.has(toId)) {
      pairs.push({ fromId, toId });
    }
  }
  return pairs;
}

// buildCrossProjectPerformerMapping（1枚のslideのみ対象）の複数slide版。コピーした全slideの
// placementsに登場する全performerIdをSetで統合してから、number+nameでの対応付けを1回だけ行う。
// 判定ルール（performerCrossProjectKeysMatch）は単体用と完全に同一。同じ出演者が複数slideに
// 登場していても、placementIdsはSetのため重複なく1回だけ扱われ、結果としてunmatchedSourcePerformers
// にも1回しか現れない（複数構成分の警告を1回にまとめるための土台）。
function buildCrossProjectPerformerMappingForSlides(sourceSlides, sourcePerformersSnapshot, targetPerformers) {
  const placementIds = new Set();
  (Array.isArray(sourceSlides) ? sourceSlides : []).forEach((slide) => {
    Object.keys((slide && slide.placements) || {}).forEach((id) => placementIds.add(id));
  });
  const snapshotById = new Map();
  (Array.isArray(sourcePerformersSnapshot) ? sourcePerformersSnapshot : []).forEach((sp) => {
    if (sp && typeof sp.id === "string") snapshotById.set(sp.id, sp);
  });
  const targets = Array.isArray(targetPerformers) ? targetPerformers : [];
  const matchedMap = new Map();
  const unmatchedSourcePerformers = [];
  placementIds.forEach((sourcePerformerId) => {
    const sourceInfo = snapshotById.get(sourcePerformerId);
    if (!sourceInfo) return;
    const target = targets.find((tp) => performerCrossProjectKeysMatch(sourceInfo, tp));
    if (target) {
      matchedMap.set(sourcePerformerId, target.id);
    } else {
      unmatchedSourcePerformers.push(sourceInfo);
    }
  });
  return { matchedMap, unmatchedSourcePerformers };
}

// insertSlideCopyAfter（単体・1枚だけを指定afterIndexの直後へ挿入する既存関数）の複数版。
// 選択された複数slideを、元Project内の順序を保ったまま指定afterIndexの直後へまとめて挿入する。
// 1回の呼び出しで、
//   1. 各sourceSlideをdeep copy
//   2. 全slideへ新しいslide.idを発行し、oldSlideId→newSlideIdの対応（順序）を作る
//   3. afterIndexの直後へ、元Project順のまま一括挿入
//   4. reconcileTransitionCounts / reconcileTransitionPaths（既存関数をそのまま再利用）で、
//      貼り付け先Project内の「今回の挿入と無関係な既存の隣接ペア」をそのまま維持する
//      （この時点で、挿入によって新しく生まれる境界2箇所＝「直前の既存slide→先頭の新slide」
//      「末尾の新slide→直後の既存slide」は、新idゆえ必ずdefaultへフォールバックする＝仕様通り）
//   5. sourceInternalTransitionCounts/Paths（コピー時点で「元Projectで直接隣接していた選択
//      slide同士」だけに絞って渡される、旧fromSlideIdをキーにしたmap。呼び出し側が
//      findAdjacentSelectedSlidePairsの結果から事前に作る）を使い、新しく生まれた内部ペア
//      （newSlides[i]→newSlides[i+1]）へ値を移植する（4のreconcileは新規idゆえ必ず
//      「無関係な新規ペア」と判定するため、reconcileだけでは絶対に復元できない。ここで
//      明示的に上書きすることで初めて実現できる＝前回調査で報告した通り）。
// performerIdMapがnull（＝同一Project内一括コピー）の場合は、placements・musicAnchor・
// transitionPaths内のperformerIdキーには一切手を加えない（既存単体コピーと同じ挙動を維持）。
// performerIdMapが渡された場合（＝Project間一括コピー）は、各slideのplacementsのキーを
// 対応表で変換（未対応は除外）、musicAnchorをnullに、internalTransitionPaths内の
// performerIdキーも同様に変換・未対応は除外する。
//
// 戻り値：{ nextSlides, nextTransitionCounts, nextTransitionPaths, newSlideIds }
//   newSlideIdsはsourceSlidesと同じ並び順で発行された新しいslide.idの配列。
function insertSlidesCopyAfter(
  prevSlides,
  prevTransitionCounts,
  prevTransitionPaths,
  sourceSlides,
  sourceInternalTransitionCounts,
  sourceInternalTransitionPaths,
  performerIdMap,
  afterIndex
) {
  if (!Array.isArray(sourceSlides) || sourceSlides.length === 0) {
    return {
      nextSlides: prevSlides,
      nextTransitionCounts: prevTransitionCounts,
      nextTransitionPaths: prevTransitionPaths,
      newSlideIds: [],
    };
  }
  const isCrossProject = performerIdMap != null;

  // 1〜2. deep copy + 新規id発行。
  const newSlides = sourceSlides.map((sourceSlide) => {
    const copied = deepCopyPlainObject(sourceSlide);
    const newId = makeId("slide");
    let nextPlacements = copied.placements || {};
    let nextMusicAnchor = copied.musicAnchor;
    let nextMusicPlaybackStartMode = copied.musicPlaybackStartMode;
    if (isCrossProject) {
      const translatedPlacements = {};
      Object.keys(nextPlacements).forEach((oldPerformerId) => {
        const newPerformerId = performerIdMap.get(oldPerformerId);
        if (!newPerformerId) return; // 未一致→このslideのこの出演者のplacementは除外
        translatedPlacements[newPerformerId] = nextPlacements[oldPerformerId];
      });
      nextPlacements = translatedPlacements;
      nextMusicAnchor = null; // Project間コピーはコピー元ProjectのsectionIdを持ち込まない
      // 再生開始モード v1・STEP11：musicPlaybackStartModeも同じ理由で"anchor"へリセットする
      // （参照先のmusicAnchorはnullなのに「曲頭から」設定だけが残る、という不整合を防ぐ）。
      nextMusicPlaybackStartMode = "anchor";
    }
    return { ...copied, id: newId, placements: nextPlacements, musicAnchor: nextMusicAnchor, musicPlaybackStartMode: nextMusicPlaybackStartMode };
  });
  const newSlideIds = newSlides.map((s) => s.id);

  // 3. afterIndexの直後へ、元Project順のまま一括挿入。
  const insertAt = afterIndex + 1;
  const nextSlides = [...prevSlides.slice(0, insertAt), ...newSlides, ...prevSlides.slice(insertAt)];

  // 4. 既存reconcileで、貼り付け先Project内の無関係な既存ペアをそのまま維持する。
  let nextTransitionCounts = reconcileTransitionCounts(prevTransitionCounts, prevSlides, nextSlides);
  let nextTransitionPaths = reconcileTransitionPaths(prevTransitionPaths, prevSlides, nextSlides);

  // 5. コピー元で直接隣接していた選択slide同士の内部transitionを、新idへ移植する。
  //    0countも正式値のため、hasOwnPropertyで明示判定する（truthy判定で0を弾かない）。
  for (let i = 0; i < sourceSlides.length - 1; i++) {
    const oldFromId = sourceSlides[i].id;
    const newFromId = newSlideIds[i];
    if (Object.prototype.hasOwnProperty.call(sourceInternalTransitionCounts || {}, oldFromId)) {
      nextTransitionCounts = { ...nextTransitionCounts, [newFromId]: sourceInternalTransitionCounts[oldFromId] };
    }
    if (sourceInternalTransitionPaths && Object.prototype.hasOwnProperty.call(sourceInternalTransitionPaths, oldFromId)) {
      let nextPathsForSlide = deepCopyPlainObject(sourceInternalTransitionPaths[oldFromId]);
      if (isCrossProject) {
        const translated = {};
        Object.keys(nextPathsForSlide).forEach((oldPerformerId) => {
          const newPerformerId = performerIdMap.get(oldPerformerId);
          if (!newPerformerId) return; // 未一致→このtransitionPathは除外
          translated[newPerformerId] = nextPathsForSlide[oldPerformerId];
        });
        nextPathsForSlide = translated;
      }
      nextTransitionPaths = { ...nextTransitionPaths, [newFromId]: nextPathsForSlide };
    }
  }

  return { nextSlides, nextTransitionCounts, nextTransitionPaths, newSlideIds };
}

// ------------------------------------------------------------------
// Undo / Redo（履歴管理）
// ------------------------------------------------------------------
// 履歴に保存する「作品データ」は最低限 stage / performers / slides / currentSlideIndex を
// ひとまとめにしたオブジェクト（＝ work ）として扱う。viewState（zoom/pan）や
// selectedIds（選択状態）はUI専用のstateとして別管理し、履歴には一切含めない。
// 将来 lights（照明）や timeline（タイムライン）を追加する場合も、この work オブジェクトに
// キーを増やすだけで同じ履歴構造にそのまま乗せられる。
const HISTORY_LIMIT = 100;

// 汎用の Undo/Redo フック。将来的に別ファイルの custom hook へそのまま切り出せるよう、
// このコンポーネント特有のロジック（zones・placements の形など）には一切依存しない形にしてある。
//   - commit(updater)      : 1回の呼び出し＝1件の履歴（ボタン操作やプルダウン変更など、都度確定してよい操作用）
//   - updateLive(updater)  : 履歴を増やさず「見た目」だけ更新する（ドラッグ中・入力中のプレビュー用）
//   - beginBatch()         : 連続操作の直前の状態を記録する（ドラッグ開始・入力欄フォーカス時に呼ぶ）
//   - endBatch()           : beginBatch以降の変化をまとめて1件の履歴として確定する（ドラッグ終了・blur/Enter時に呼ぶ）
//   - undo() / redo()      : 履歴を1件戻す・進める
function useHistoryState(initialPresent, limit = HISTORY_LIMIT) {
  const [state, setState] = useState({ past: [], present: initialPresent, future: [] });
  const batchBaselineRef = useRef(null);

  const commit = useCallback(
    (updater) => {
      setState((cur) => {
        const nextPresent = typeof updater === "function" ? updater(cur.present) : updater;
        if (nextPresent === cur.present) return cur;
        return {
          past: [...cur.past, cur.present].slice(-limit),
          present: nextPresent,
          future: [],
        };
      });
    },
    [limit]
  );

  const updateLive = useCallback((updater) => {
    setState((cur) => ({
      ...cur,
      present: typeof updater === "function" ? updater(cur.present) : updater,
    }));
  }, []);

  const beginBatch = useCallback(() => {
    setState((cur) => {
      batchBaselineRef.current = cur.present;
      return cur;
    });
  }, []);

  // Undo/Redo修復・PART A原因：endBatchのsetState updaterが「batchBaselineRef.currentをnullへ
  // 書き換える」という副作用を持っていたため、非純粋（impure）なupdater関数になっていた。
  // React（開発時のStrictMode）はstateのupdater関数を2回連続で呼び出して純粋性をチェックする
  // ことがあり、1回目の呼び出しでbatchBaselineRef.currentが正しくnullへクリアされた直後に
  // 2回目の呼び出しが同じcur（stateはまだ変化していないため）に対して実行されると、
  // 2回目はすでにnullになったbaselineを読んでしまい「baseline == null」の早期returnへ入り、
  // 1回目で計算したはずの履歴追加（past配列への追加）が握りつぶされてしまっていた。
  // これが「番号・色・名前入力やドラッグ操作（すべてbeginBatch〜endBatchを使う）のUndoが
  // 効かないことがある」という症状の直接原因（名前機能自体は無関係で、既存のbeginBatch/
  // endBatchの設計に元々あった副作用が、操作数が増えたことで顕在化した）。
  // 修正方針：batchBaselineRef の読み取り・クリアをsetStateのupdater関数の外側で行い、
  // updater自体は「baseline（読み取り済みの定数）とcurだけから結果を計算する」という
  // 純粋な関数にする。これにより、React が updater を何度呼び出しても結果は常に同じになる。
  const endBatch = useCallback(() => {
    const baseline = batchBaselineRef.current;
    batchBaselineRef.current = null;
    if (baseline == null) return;
    setState((cur) => {
      if (baseline === cur.present) return cur;
      return {
        past: [...cur.past, baseline].slice(-limit),
        present: cur.present,
        future: [],
      };
    });
  }, [limit]);

  const undo = useCallback(() => {
    setState((cur) => {
      if (cur.past.length === 0) return cur;
      const previous = cur.past[cur.past.length - 1];
      return {
        past: cur.past.slice(0, -1),
        present: previous,
        future: [cur.present, ...cur.future].slice(0, limit),
      };
    });
  }, [limit]);

  const redo = useCallback(() => {
    setState((cur) => {
      if (cur.future.length === 0) return cur;
      const next = cur.future[0];
      return {
        past: [...cur.past, cur.present].slice(-limit),
        present: next,
        future: cur.future.slice(1),
      };
    });
  }, [limit]);

  // Multi Project v1で追加：履歴（past/future）を空にした状態でpresentだけを丸ごと
  // 入れ替える。Project切替時にだけ使う想定で、通常の作品編集からは呼ばない。
  // 「Project AでUndoしたらProject Bの編集が変わる」事故を構造的に防ぐため、
  // 切替の瞬間に履歴を必ずリセットする（13章の設計判断）。
  const reset = useCallback((nextPresent) => {
    batchBaselineRef.current = null;
    setState({ past: [], present: nextPresent, future: [] });
  }, []);

  return {
    present: state.present,
    commit,
    updateLive,
    beginBatch,
    endBatch,
    undo,
    redo,
    reset,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
  };
}

// ------------------------------------------------------------------
// 平面図系マーカー共通定義（人物マーカー表示の改善・PART A）
// ------------------------------------------------------------------
// TopView（通常編集画面）・FormationThumbnail（構成一覧）・平面図PNG（drawTopPerformerMarker）
// の3箇所が共有する、「出演者カラーでベタ塗りした丸＋中央に白い数字」というデザインルールの
// 単一の定義（7章）。SVG（TopView・FormationThumbnail）とCanvas（PNG Export）は描画APIが
// 異なるため無理に1つの関数へ統合はしないが、少なくとも「半径に対する比率・番号フォント
// サイズの計算式・色」はここへ集約し、両方の描画コードから同じ値だけを参照する。
// 以前あった人型シルエット（肩の楕円＋頭の円＝TopFigure）は平面図では廃止し、単純な円に
// 統一した（1章：「誰がどこにいるか」の判別を最優先するデザイン）。俯瞰客席ビュー
// （FrontFigure）は今回の変更対象外のため、一切変更していない（6章）。
const TOP_MARKER_STROKE_COLOR = "rgba(255,255,255,0.35)"; // 非常に薄い外周線。数字の視認性を妨げない程度に留める（4章）
const TOP_MARKER_STROKE_WIDTH_RATIO = 0.045; // radiusに対する外周線の太さの比率
const TOP_MARKER_TEXT_COLOR = "#ffffff"; // 番号は白（1章）
const TOP_MARKER_FONT_BASE_SCALE_SCREEN = 1.35; // TopView・FormationThumbnail（画面表示）用。旧TopFigure+text時代の値をそのまま踏襲

// 丸マーカー向けの番号フォントサイズ計算。既存performerNumberFontSize()（1桁/2桁のサイズ差を
// 決めるロジック）をそのまま再利用しつつ（2章：可能な限り既存helperを再利用する）、3桁以降
// （100番以降）はさらに一段階縮小し、円からはみ出さないようにする薄いラッパー。
function topMarkerNumberFontSize(radius, number, baseScale) {
  const base = performerNumberFontSize(radius * baseScale, number);
  const digits = String(number).length;
  return digits >= 3 ? base * 0.82 : base;
}

// TopView・FormationThumbnail共通のSVGマーカー。円＋中央の白い数字だけのシンプルな
// デザイン（1章）。selected（選択中）・warn（範囲外／重なり警告）の強調は、旧TopFigureと
// 同じ考え方（マーカーの外側に色付きリングを1本足すだけ）を、楕円→円に合わせて引き継ぐ。
function TopPerformerMarker({ color, selected, warn, radius, number }) {
  const fontSize = topMarkerNumberFontSize(radius, number, TOP_MARKER_FONT_BASE_SCALE_SCREEN);
  const strokeWidth = Math.max(1, radius * TOP_MARKER_STROKE_WIDTH_RATIO);
  return (
    <g>
      {warn && (
        <circle cx={0} cy={0} r={radius + 8} fill="none" stroke={THEME.danger} strokeWidth={3} strokeDasharray="6 5" />
      )}
      {selected && <circle cx={0} cy={0} r={radius + 5} fill="none" stroke={THEME.accent} strokeWidth={3} />}
      <circle cx={0} cy={0} r={radius} fill={color} stroke={TOP_MARKER_STROKE_COLOR} strokeWidth={strokeWidth} />
      <text
        x={0}
        y={radius * 0.05}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={fontSize}
        fontWeight="bold"
        fill={TOP_MARKER_TEXT_COLOR}
      >
        {number}
      </text>
    </g>
  );
}

// ------------------------------------------------------------------
// 人型シルエット（正面視点）
// ------------------------------------------------------------------
// 姿勢 v1：pose="kneeling"のときは片膝立ち用のFrontFigureKneelingへ委譲する。
// standing側の描画（デザイン・比率）は一切変更していない（6章の方針通り）。
// 身長 v2・PART E〜G：体格（X方向）は固定し、身長差はY方向だけに反映する。
// FrontFigure（standing）・computeKneelingFigureGeometry（kneeling）の両方が、
//   H = heightPx（実際の身長 → Y方向の位置・長さの基準）
//   R = refHeightPx（DEFAULT_PERFORMER_HEIGHT基準の固定heightPx → X方向のサイズの基準）
// という2つの基準を使い分ける。Rは「身長差を無視して体格を固定する」ための値で、
// scale・sizeComp・遠近など位置由来のスケーリングはHと同様に反映される（同じ計算式で
// DEFAULT_PERFORMER_HEIGHT × scale × sizeCompとして呼び出し側が算出する＝PART F）。
// refHeightPxを渡さない呼び出し元がもし残っていても、heightPxそのものにフォールバックする
// ことで、従来どおり（X=Yとも同じ比率で変化する挙動）のまま安全に動作する。
// ------------------------------------------------------------------
// 人型シルエット（正面視点）：X方向の共通サイズ定数
// ------------------------------------------------------------------
// standing（FrontFigure）・kneeling（computeKneelingFigureGeometry）の両方が、この同じ
// 比率をrefHeightPx（体格の基準値。身長presetでは変えない＝X/Y分離方針）へ掛けて使う
// （PART M：standing/kneelingで基本のX方向寸法を必ず共有する）。
// 密集フォーメーションで隣の出演者と一体化しにくくするため、従来比で肩幅/胴体幅・腕・脚を
// 約12〜13%細くした（PART K）。頭の半径だけは視認性のため変更していない（PART K）。
const FIGURE_HEAD_R_RATIO = 0.07; // 頭の半径（変更なし）
const FIGURE_TORSO_W_RATIO = 0.16; // 肩幅・胴体幅（半幅）。従来0.185から約13%細く
const FIGURE_ARM_W_RATIO = 0.044; // 腕の太さ。従来0.05から約12%細く
const FIGURE_LEG_W_RATIO = 0.078; // 脚の太さ。従来0.09から約13%細く
const FIGURE_LEG_GAP_RATIO = 0.026; // 脚の間隔（中心からの片側オフセット）。従来0.03から約13%細く

function FrontFigure({ color, selected, warn, heightPx, pose, refHeightPx }) {
  if (pose === POSE_KNEELING) {
    return <FrontFigureKneeling color={color} selected={selected} warn={warn} heightPx={heightPx} refHeightPx={refHeightPx} />;
  }
  const H = heightPx; // Y方向（実際の身長差を反映）
  const R = refHeightPx != null ? refHeightPx : heightPx; // X方向（体格の基準・身長presetで変えない）
  const headR = R * FIGURE_HEAD_R_RATIO;
  const headCy = -H + headR;
  const shoulderY = -H * 0.84;
  const hipY = -H * 0.46;
  const torsoW = R * FIGURE_TORSO_W_RATIO;
  const armW = R * FIGURE_ARM_W_RATIO;
  const legW = R * FIGURE_LEG_W_RATIO;
  const legGap = R * FIGURE_LEG_GAP_RATIO;

  return (
    <g>
      {warn && (
        <rect
          x={-torsoW}
          y={-H - headR * 2}
          width={torsoW * 2}
          height={H + headR * 2}
          fill="none"
          stroke={THEME.danger}
          strokeWidth={3}
          strokeDasharray="6 5"
          rx={6}
        />
      )}
      {selected && (
        <rect
          x={-torsoW - 6}
          y={-H - headR * 2 - 6}
          width={torsoW * 2 + 12}
          height={H + headR * 2 + 12}
          fill="none"
          stroke={THEME.accent}
          strokeWidth={3}
          rx={8}
        />
      )}
      {/* 脚 */}
      <rect x={-legGap - legW} y={hipY} width={legW} height={H - Math.abs(hipY)} rx={legW * 0.3} fill={color} />
      <rect x={legGap} y={hipY} width={legW} height={H - Math.abs(hipY)} rx={legW * 0.3} fill={color} />
      {/* 腕 */}
      <rect x={-torsoW - armW} y={shoulderY} width={armW} height={Math.abs(hipY - shoulderY) * 0.95} rx={armW * 0.3} fill={color} opacity={0.9} />
      <rect x={torsoW} y={shoulderY} width={armW} height={Math.abs(hipY - shoulderY) * 0.95} rx={armW * 0.3} fill={color} opacity={0.9} />
      {/* 胴体 */}
      <path
        d={`M ${-torsoW} ${shoulderY} L ${torsoW} ${shoulderY} L ${torsoW * 0.8} ${hipY} L ${-torsoW * 0.8} ${hipY} Z`}
        fill={color}
      />
      {/* 頭 */}
      <circle cx={0} cy={headCy} r={headR} fill={color} stroke={THEME.bg} strokeWidth={1.5} />
    </g>
  );
}

// 姿勢 v1.3：片膝立ち人形の共通ジオメトリ計算（pure helper）。
// SVG版（FrontFigureKneeling）・Canvas Export版（drawExportPerformerKneeling）・
// 番号タグ位置（frontFigureChestMetrics）の3箇所すべてがこの1つの関数の戻り値だけを
// 参照することで、数値が食い違わないようにする（PART 17：SVGとCanvasを必ず揃える）。
//
// v1.3の方針転換：これまでの版は「人体としてなるべく正確な片膝」を目指し、太もも角度・膝の
// 折れ・複数segmentの折り畳み脚などを積み重ねてきたが、俯瞰客席ビューでは人形自体が小さいため、
// segmentや角度が増えるほど逆に「座っている」「脚が変な方向へ伸びている」ように見えてしまって
// いた（実機Safariで確認）。v1.3では依頼者が作成した参考イメージのシルエットに合わせ、
// 「人体として正確な片膝」ではなく「一目で片膝だと分かる記号的シルエット」を優先する：
//   ・画面左（人形自身の右脚）＝腰から床までまっすぐ伸びる「長い脚」1本のみ。
//     太もも角度・膝の折れなど人体的geometryは持たせない。
//   ・画面右（人形自身の左脚）＝腰から床までの半分程度で止まる「短い脚」＋その先に付く
//     小さな斜めパーツ1本（後方へ折り畳まれた足のごく単純な記号）だけの2segmentのみ。
//   ・長い脚と短い脚の「長さの違い」自体が「片膝をついている」を伝える主な手がかりになる。
//   ・頭の大きさ（headR）・肩幅／胴体幅（torsoW）・腕の太さ（armW）・脚の太さ（legW）は、
//     standing（FrontFigure）と全く同じ比率定数（FIGURE_*_RATIO）を共有する
//     （PART 3・4・8：「小さい人」ではなく「同じ人が姿勢を低くした」ように見せる）。
//   ・腰の位置（hipY）だけを大きく下げる（脚を折り畳んだ結果として腰・頭の位置が下がる）。
//     人形全体へ一律の縮小比率を掛ける方式には戻さない（PART 5・9）。
//
// 身長 v2・X/Y分離方針は維持：
//   H = heightPx（実際の身長 → Y方向の位置・長さの基準）
//   R = refHeightPx（DEFAULT_PERFORMER_HEIGHT基準の固定heightPx → X方向のサイズの基準）
// 短い脚の先の斜めパーツも、横方向の張り出し（X）はR基準、縦方向の伸び（Y）はH基準にすることで、
// 小・中・大で斜めパーツの横幅が変わらないようにする（PART 16）。
const KNEEL_HIP_HEIGHT_RATIO = 0.2; // 腰の高さ＝立ち姿の20%（脚を折り畳むことで全高を下げる）
const KNEEL_TORSO_SPAN_RATIO = 0.34; // 肩〜腰の距離。standingの0.38（0.84-0.46）に近い値を維持
const KNEEL_NECK_GAP_RATIO = 0.02; // 頭と肩の間隔比率。standingと同じ考え方（headR分＋わずかな隙間）
const KNEEL_SHORT_LEG_RATIO = 0.5; // 短い脚の長さ（長い脚＝腰〜床の距離に対する比率。半分で止める）
const KNEEL_DIAGONAL_LEN_RATIO = 0.45; // 膝下斜めパーツの縦方向の長さ（短い脚の縦segment長に対する比率）。
// 「北東」だと横寄りに見えていたため、35%→45%へ引き上げ、縦方向の上昇量を相対的に大きくした。
const KNEEL_DIAGONAL_DX_LEGW_MULT = 0.9; // 膝下斜めパーツの横方向の長さ（legWの倍数。R基準で体格固定）。
// 上と対になる調整として1.3→0.9へ縮小し、「北北東」（北寄りの右上）に見えるようにした。
// この2つの値の組み合わせは、角度を北東（鉛直から約71度）→北北東（同約57度）へ寄せつつ、
// 見た目の総延長の変化を約22%減に抑える（比率の変更だけで方向を変える・極端な長さ変更はしない）。

function computeKneelingFigureGeometry(heightPx, refHeightPx) {
  const H = heightPx; // Y方向（実際の身長差を反映）
  const R = refHeightPx != null ? refHeightPx : heightPx; // X方向（体格の基準・身長presetで変えない）
  // 頭・肩幅・腕・脚の太さはstandingのFrontFigureと全く同じ比率定数を共有する（PART G）。
  const headR = R * FIGURE_HEAD_R_RATIO;
  const torsoW = R * FIGURE_TORSO_W_RATIO;
  const armW = R * FIGURE_ARM_W_RATIO;
  const legW = R * FIGURE_LEG_W_RATIO;
  const legGap = R * FIGURE_LEG_GAP_RATIO;

  const hipY = -H * KNEEL_HIP_HEIGHT_RATIO;
  const shoulderY = hipY - H * KNEEL_TORSO_SPAN_RATIO;
  const headCy = shoulderY - (headR + H * KNEEL_NECK_GAP_RATIO);
  const armH = Math.abs(hipY - shoulderY) * 0.95;

  // 左右の脚のX位置：standingの脚（rect、x=-legGap-legW〜-legGap、および x=legGap〜legGap+legW）と
  // 完全に同じ中心線（-legGap-legW/2、legGap+legW/2）を使う（PART A：kneelingで脚が中央へ
  // 寄ってしまっていた問題の修正。以前は内側の縁＝±legGapをそのまま線のx座標に使っていたため、
  // standingよりlegW分だけ内側に寄っていた）。
  const hipXLong = -(legGap + legW / 2); // 長い脚（画面左＝人形自身の右脚）
  const hipXShort = legGap + legW / 2; // 短い脚（画面右＝人形自身の左脚）

  // 短い脚（画面右＝人形自身の左脚）：腰〜床の距離（＝長い脚の長さ）の半分程度で止める1本。
  const legDrop = Math.abs(hipY); // 腰から床までの縦距離（＝長い脚の長さ）
  const shortLegDropLen = legDrop * KNEEL_SHORT_LEG_RATIO;
  const shortLegEndY = hipY + shortLegDropLen;

  // 膝下の斜めパーツ：短い脚の先から北北東（画面右上寄り、やや縦方向寄り）へ伸ばす。
  // 俯瞰客席ビューの画面座標は上へ行くほどYが小さくなるため、北北東＝X増加（控えめ）・
  // Y減少（大きめ）になる。縦方向の長さ（Y、H基準）は短い脚の縦segment長の約42%、
  // 横方向（X、R基準）はlegWの0.8倍を基準にすることで、横への張り出しを北東版より抑えつつ、
  // 身長presetで横への張り出しが変わらないようにする（PART H・E）。
  const diagDy = shortLegDropLen * KNEEL_DIAGONAL_LEN_RATIO;
  const diagDx = legW * KNEEL_DIAGONAL_DX_LEGW_MULT;
  const diagEndX = hipXShort + diagDx; // 東（右。北東版より控えめ）
  const diagEndY = shortLegEndY - diagDy; // 北（上。北東版より大きめ）

  return {
    H,
    headR,
    headCy,
    shoulderY,
    hipY,
    torsoW,
    armW,
    armH,
    legW,
    hipXLong,
    hipXShort,
    shortLegEndY,
    diagEndX,
    diagEndY,
  };
}

// 姿勢 v1.3：片膝立ち人形（SVG・俯瞰客席ビュー画面用）。デザイン言語（頭・胴体・脚を簡略化した
// 図形、腕はニュートラル）はstandingのFrontFigureをそのまま踏襲し、ジオメトリは
// computeKneelingFigureGeometry()の計算結果だけを使う（二重実装しない＝PART 17）。
// 出演者番号のタグ位置（OverheadAudienceView側）はheightPxそのものを基準に計算しているため、
// このコンポーネント自体は番号を描画しない（standingと同じ役割分担）。
function FrontFigureKneeling({ color, selected, warn, heightPx, refHeightPx }) {
  const { H, headR, headCy, shoulderY, hipY, torsoW, armW, armH, legW, hipXLong, hipXShort, shortLegEndY, diagEndX, diagEndY } =
    computeKneelingFigureGeometry(heightPx, refHeightPx);

  return (
    <g>
      {warn && (
        <rect
          x={-torsoW - legW}
          y={-H - headR * 2}
          width={torsoW * 2 + legW * 2}
          height={H + headR * 2}
          fill="none"
          stroke={THEME.danger}
          strokeWidth={3}
          strokeDasharray="6 5"
          rx={6}
        />
      )}
      {selected && (
        <rect
          x={-torsoW - legW - 6}
          y={-H - headR * 2 - 6}
          width={torsoW * 2 + legW * 2 + 12}
          height={H + headR * 2 + 12}
          fill="none"
          stroke={THEME.accent}
          strokeWidth={3}
          rx={8}
        />
      )}
      {/* 長い脚（画面左＝人形自身の右脚）：腰から床までまっすぐ伸びる1本のみ。 */}
      <line x1={hipXLong} y1={hipY} x2={hipXLong} y2={0} stroke={color} strokeWidth={legW} strokeLinecap="round" />
      {/* 短い脚（画面右＝人形自身の左脚）：腰から床までの半分程度で止める1本＋その先の
          小さな斜めパーツ1本（後方へ折り畳まれた足の記号）。長い脚との長さの違いが
          「片膝をついている」ことを伝える主な手がかりになる。 */}
      <line x1={hipXShort} y1={hipY} x2={hipXShort} y2={shortLegEndY} stroke={color} strokeWidth={legW} strokeLinecap="round" />
      <line x1={hipXShort} y1={shortLegEndY} x2={diagEndX} y2={diagEndY} stroke={color} strokeWidth={legW * 0.9} strokeLinecap="round" />
      {/* 腕（ニュートラル。standingと同じ考え方で肩から下ろす） */}
      <rect x={-torsoW - armW} y={shoulderY} width={armW} height={armH} rx={armW * 0.3} fill={color} opacity={0.9} />
      <rect x={torsoW} y={shoulderY} width={armW} height={armH} rx={armW * 0.3} fill={color} opacity={0.9} />
      {/* 胴体 */}
      <path
        d={`M ${-torsoW} ${shoulderY} L ${torsoW} ${shoulderY} L ${torsoW * 0.8} ${hipY} L ${-torsoW * 0.8} ${hipY} Z`}
        fill={color}
      />
      {/* 頭 */}
      <circle cx={0} cy={headCy} r={headR} fill={color} stroke={THEME.bg} strokeWidth={1.5} />
    </g>
  );
}

// 姿勢 v1：胸の番号タグ（俯瞰客席ビュー・PNG Export共通）の位置・幅を姿勢ごとに計算する
// pure helper。standing側のchestWidthは身長 v2・PART Eにより、実際の身長（heightPx）ではなく
// 固定の体格基準（refHeightPx）から求める（＝小・中・大で番号タグの横幅が変わらないように
// する。胸部・胴体を基準にした位置の考え方自体は維持し、脚のgeometry変更の影響を受けない
// ＝PART C）。tagOffsetY（縦位置）は引き続きheightPx（実際の身長）を基準にする。
// kneeling側はcomputeKneelingFigureGeometry()の戻り値（shoulderY・hipY・torsoW）だけを使う
// ことで、人形の見た目を変えても番号位置が独自にズレないようにする（PART C）。
function frontFigureChestMetrics(heightPx, pose, refHeightPx) {
  const H = heightPx;
  const R = refHeightPx != null ? refHeightPx : heightPx;
  if (pose === POSE_KNEELING) {
    const { shoulderY, hipY, torsoW } = computeKneelingFigureGeometry(H, R);
    return { tagOffsetY: (shoulderY + hipY) / 2, chestWidth: torsoW * 2 };
  }
  // PART N：chestWidthはFrontFigureのtorsoW*2と同じ計算式（FIGURE_TORSO_W_RATIO）を使う。
  // 身体のスリム化（PART K）に追従させることで、番号タグが胴体からはみ出さないようにする。
  return { tagOffsetY: -H * 0.62, chestWidth: R * FIGURE_TORSO_W_RATIO * 2 };
}

// ------------------------------------------------------------------
// 平面図の座標変換（舞台座標 → 画面座標）：pure helper
// ------------------------------------------------------------------
// 構成一覧 v1・4章：既存TopViewの「舞台本体・待機エリア・出演者配置がすべて収まる範囲を
// 求め、その範囲をコンテンツ座標（cm単位）へマッピングする」計算式を、TopView専用の
// useMemo/useCallbackの中身から、React非依存の純粋関数として切り出したもの。
// TopView本体（真上視点ステージ）と、構成一覧のFormationThumbnail（読み取り専用の
// 縮小版）の両方から同じ関数を呼ぶことで、座標変換ロジックを二重実装しない。
// marginは呼び出し側の用途に応じて指定できる（TopViewは95、FormationThumbnailは
// コンパクトな表示のためもっと小さい値を渡す＝25章）。挙動そのもの（bounds・toScreenX/Y
// の計算式）はTopViewの元の実装から一切変更していない。
// 余白最適化：TopView編集画面（computeStageViewBounds）とFormationThumbnail/Export
// （computeFormationThumbnailBounds）の両方が、この共通の「safe padding比率」を使う。
// 以前はTopViewが固定95cm相当・Export側が独自のPADDING_RATIO=0.08という別々の値を
// 持っており、編集画面とExportで余白の見え方が揃っていなかった。stage + 待機エリアの
// 実寸に対する比率にすることで、ステージサイズが変わっても常に同程度の密度（コンテンツが
// 表示領域のおよそ92〜94%程度を占める）になり、かつ編集画面とExportで同じ考え方を共有する。
// 「何をbounds対象にするか」「どの程度のpaddingを設けるか」というルールだけを共有し、
// 実際のズーム値・fit計算（TopViewのzoom/pan、Exportのcontain-fit）はそれぞれ独立のまま。
const STAGE_VIEW_PADDING_RATIO = 0.04;
// 極端に小さいステージでも、下手袖・上手袖・舞台奥ラベルや軸目盛りが切れない最低限の
// paddingを確保する（cm相当の単位。UNIT_CM=90なのでおよそ0.2〜0.3グリッド分に相当）。
const STAGE_VIEW_MIN_PADDING_CM = 20;

function computeStageViewBounds(stage, zones, performers, placements, marginOverride) {
  const stageWcm = stage.width * UNIT_CM;
  const stageDcm = stage.depth * UNIT_CM;
  let minX = Math.min(-stageWcm / 2, zones.stageLeft.xMin * UNIT_CM);
  let maxX = Math.max(stageWcm / 2, zones.stageRight.xMax * UNIT_CM);
  let minY = 0;
  let maxY = Math.max(stageDcm, zones.upstageBackstage.yMax * UNIT_CM);
  performers.forEach((p) => {
    const pos = placements[p.id];
    if (!pos) return;
    const x = pos.x * UNIT_CM;
    const y = pos.y * UNIT_CM;
    minX = Math.min(minX, x - 60);
    maxX = Math.max(maxX, x + 60);
    minY = Math.min(minY, y - 60);
    maxY = Math.max(maxY, y + 60);
  });
  const contentW = maxX - minX;
  const contentD = maxY - minY;
  // marginOverrideが渡された場合は既存呼び出し元との後方互換のため優先する（現状の呼び出し
  // 元はすべて省略しているため、通常はSTAGE_VIEW_PADDING_RATIOベースの比率paddingになる）。
  const padX = marginOverride != null ? marginOverride : Math.max(contentW * STAGE_VIEW_PADDING_RATIO, STAGE_VIEW_MIN_PADDING_CM);
  const padY = marginOverride != null ? marginOverride : Math.max(contentD * STAGE_VIEW_PADDING_RATIO, STAGE_VIEW_MIN_PADDING_CM);
  return {
    minX,
    maxX,
    minY,
    maxY,
    leftMargin: padX,
    rightMargin: padX,
    topMargin: padY,
    bottomMargin: padY,
    totalW: contentW + padX * 2,
    totalH: contentD + padY * 2,
  };
}
function stageViewToScreenX(bounds, xUnits) {
  return bounds.leftMargin + (xUnits * UNIT_CM - bounds.minX);
}
function stageViewToScreenY(bounds, yUnits) {
  return bounds.topMargin + (bounds.maxY - yUnits * UNIT_CM);
}

// 構成一覧 v1.1：FormationThumbnail専用のbounds計算。
// 通常のTopView（computeStageViewBounds）は「ステージ本体＋待機エリア＋出演者配置が
// すべて収まる範囲」を毎回演者位置から動的に計算するため、構成ごとに出演者の分布が
// 違うと実質的な画角（zoom率）がカードごとにバラついてしまう（＝これが「サムネイル内で
// ステージ全体が十分に見えない／構成間で画角が揃わない」ことの原因）。
// 構成一覧の目的は「同じ画角でステージ全体を並べて見比べること」なので、fit対象を
// 出演者位置に一切依存させず、常に stage.width / stage.depth という固定のステージ実寸＋
// 少量のpaddingだけで決める（1〜4章・8章）。座標変換の計算式そのもの
// （stageViewToScreenX/Y）は既存のものをそのまま再利用し、二重実装しない（3章）。
// 待機エリア（stageLeft/stageRight/upstageBackstage）はfit対象には含めない（6・7章：
// v1ではステージ本体だけをfit対象とし、待機エリアの出演者が枠外に出る場合は
// クリップされてよい、という推奨仕様を採用）。
//
// PNG Export v1.2・PART I（原因報告）：第2引数zonesは今回追加した任意引数。
// v1.1のPNG Exportで「待機エリアを表示」チェックボックスをON/OFFしても見た目が
// 変わらなかった根本原因は、このzones引数が存在せず、ON時でもfit対象が常に
// ステージ本体だけ（8%程度の狭いpadding）のままだったこと。
// 待機エリアの矩形・ラベル・待機中の出演者は、袖（wingWidth）や舞台奥（backDepth）分だけ
// ステージ本体の外側にはみ出す座標を持つため、その狭いbounds/fitのままでは常に
// Canvas上でctx.clip()の範囲外（描画してもクリップされて見えない場所）に計算されてしまい、
// 「ONにしても実際には何も描かれていないのと同じ」状態になっていた（PART I詳細は
// 完了レポートを参照。数値例：stage 12×8・wingWidth 4の場合、袖の外端はcanvas座標で
// マイナス値になり、常にclip範囲外だった）。
// 修正：zonesを渡した場合だけ、待機エリア（stageLeft.xMin〜stageRight.xMax・
// upstageBackstage.yMax）もbounds計算へ含める。ここでも出演者・placementsには一切
// 依存させないため（22・23章の思想と同じ）、「同じstage+zones構成なら常に同じ画角になる」
// という既存の一貫性（構成ごとに画角がバラつかない）はそのまま維持される。
// zonesを渡さない既存の呼び出し（FormationThumbnail）は今まで通り一切挙動が変わらない
// （第2引数省略時は元の計算式と完全に同一の結果になる＝後方互換）。
function computeFormationThumbnailBounds(stage, zones) {
  const stageWcm = stage.width * UNIT_CM;
  const stageDcm = stage.depth * UNIT_CM;
  // 余白最適化：TopView編集画面（computeStageViewBounds）と同じSTAGE_VIEW_PADDING_RATIO・
  // STAGE_VIEW_MIN_PADDING_CMを使う（以前は独自のPADDING_RATIO=0.08・MIN_PADDING=10を
  // 持っていたが、編集画面とExportで余白の考え方を統一するため共通定数へ差し替えた）。
  const padX = Math.max(stageWcm * STAGE_VIEW_PADDING_RATIO, STAGE_VIEW_MIN_PADDING_CM);
  const padY = Math.max(stageDcm * STAGE_VIEW_PADDING_RATIO, STAGE_VIEW_MIN_PADDING_CM);
  let minX = -stageWcm / 2;
  let maxX = stageWcm / 2;
  let minY = 0;
  let maxY = stageDcm;
  if (zones) {
    minX = Math.min(minX, zones.stageLeft.xMin * UNIT_CM);
    maxX = Math.max(maxX, zones.stageRight.xMax * UNIT_CM);
    maxY = Math.max(maxY, zones.upstageBackstage.yMax * UNIT_CM);
  }
  return {
    minX,
    maxX,
    minY,
    maxY,
    leftMargin: padX,
    rightMargin: padX,
    topMargin: padY,
    bottomMargin: padY,
    totalW: maxX - minX + padX * 2,
    totalH: maxY - minY + padY * 2,
  };
}

// ------------------------------------------------------------------
// 真上視点ステージ
// ------------------------------------------------------------------
const TopView = forwardRef(function TopView(
  {
    stage,
    zones,
    performers,
    placements,
    selectedIds,
    onSelect,
    onToggleSelect,
    onDragGroup,
    onDragStart,
    onDragEnd,
    onRectSelect,
    overlapIds,
    showBackstage,
    showPerformerNames,
    performerDisplayScale = 1,
    performerNameScale = 1,
    viewState,
    onViewStateChange,
    width,
    height,
    locked,
    transitionPaths,
    waypointHandle,
    onWaypointDrag,
  },
  ref
) {
  const svgRef = useRef(null);
  const viewGroupRef = useRef(null);
  const [rectSelectBox, setRectSelectBox] = useState(null);
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const halfW = stage.width / 2;
  const stageWcm = stage.width * UNIT_CM;
  const stageDcm = stage.depth * UNIT_CM;

  // 構成一覧 v1・4章：bounds計算自体は共通のcomputeStageViewBounds（TopViewの元の実装と
  // 完全に同じ計算式）へ切り出した。ステージ本体だけでなく、袖・舞台奥待機エリアの分も
  // 常に画面内に収まるようにする、という挙動そのものは一切変更していない。
  // 余白最適化：固定95cm相当のマージンをやめ、computeStageViewBounds内の
  // STAGE_VIEW_PADDING_RATIOベースの比率paddingへ委ねる（第5引数を省略）。
  const bounds = useMemo(
    () => computeStageViewBounds(stage, zones, performers, placements),
    [stageWcm, stageDcm, stage, zones, performers, placements]
  );

  // toScreenX/Y・fromScreenX/Y は「コンテンツ座標（cm、ズーム前）」⇔「舞台の単位座標」の変換。
  // ズーム・パンは別レイヤー（viewGroup の transform）で扱うので、この変換式自体は
  // 拡大縮小の影響を受けず、常に同じ計算式のままでよい。
  const toScreenX = useCallback((xUnits) => stageViewToScreenX(bounds, xUnits), [bounds]);
  const toScreenY = useCallback((yUnits) => stageViewToScreenY(bounds, yUnits), [bounds]);
  const fromScreenX = useCallback((sx) => (sx - bounds.leftMargin + bounds.minX) / UNIT_CM, [bounds]);
  const fromScreenY = useCallback((sy) => (bounds.maxY - (sy - bounds.topMargin)) / UNIT_CM, [bounds]);

  const stageLeftPx = toScreenX(-halfW);
  const stageRightPx = toScreenX(halfW);
  const stageTopPx = toScreenY(stage.depth);
  const stageBottomPx = toScreenY(0);

  // グリッド線
  const gridLines = useMemo(() => {
    const lines = [];
    // 縦線（横方向の目盛り）0.5単位
    for (let i = -stage.width; i <= stage.width; i += 1) {
      const xUnits = i * 0.5;
      if (xUnits < -halfW || xUnits > halfW) continue;
      const isWhole = Number.isInteger(xUnits);
      lines.push({
        key: `v${i}`,
        x1: toScreenX(xUnits),
        x2: toScreenX(xUnits),
        y1: stageTopPx,
        y2: stageBottomPx,
        whole: isWhole,
      });
    }
    // 横線（奥行方向の目盛り）0.5単位
    for (let j = 0; j <= stage.depth * 2; j += 1) {
      const yUnits = j * 0.5;
      if (yUnits > stage.depth) continue;
      const isWhole = Number.isInteger(yUnits);
      lines.push({
        key: `h${j}`,
        x1: stageLeftPx,
        x2: stageRightPx,
        y1: toScreenY(yUnits),
        y2: toScreenY(yUnits),
        whole: isWhole,
      });
    }
    return lines;
  }, [stage.width, stage.depth, halfW, toScreenX, toScreenY, stageTopPx, stageBottomPx, stageLeftPx, stageRightPx]);

  // 座標目盛り：舞台前方（横方向・中央0）と、左右両端（奥行方向・舞台前0）。
  // stage.width / stage.depth の変更で自動的に再計算される。
  const axisTicks = useMemo(() => {
    const xTicks = [];
    const maxXTick = Math.floor(halfW);
    for (let i = 0; i <= maxXTick; i += 1) {
      xTicks.push({ key: `xt${i}`, screenX: toScreenX(i), label: String(i), isCenter: i === 0 });
      if (i !== 0) {
        xTicks.push({ key: `xt-${i}`, screenX: toScreenX(-i), label: String(i), isCenter: false });
      }
    }
    const yTicks = [];
    const maxYTick = Math.floor(stage.depth);
    for (let j = 0; j <= maxYTick; j += 1) {
      yTicks.push({ key: `yt${j}`, screenY: toScreenY(j), label: String(j) });
    }
    return { xTicks, yTicks };
  }, [halfW, stage.depth, toScreenX, toScreenY]);

  // ------------------------------------------------------------
  // 拡大縮小・画面移動（表示用の操作。出演者データそのものは一切変更しない）
  // ------------------------------------------------------------
  useImperativeHandle(ref, () => ({
    fitAll: () => onViewStateChange({ ...DEFAULT_VIEW_STATE }),
    fitStage: () => onViewStateChange(computeFitViewState(stageLeftPx, stageTopPx, stageRightPx, stageBottomPx, bounds, 0.82)),
    fitSelected: () => {
      if (!selectedIds.length) return;
      let minSx = Infinity, minSy = Infinity, maxSx = -Infinity, maxSy = -Infinity;
      selectedIds.forEach((id) => {
        const pos = placements[id];
        if (!pos) return;
        const sx = toScreenX(pos.x);
        const sy = toScreenY(pos.y);
        minSx = Math.min(minSx, sx);
        maxSx = Math.max(maxSx, sx);
        minSy = Math.min(minSy, sy);
        maxSy = Math.max(maxSy, sy);
      });
      if (!isFinite(minSx)) return;
      const r = 260;
      onViewStateChange(computeFitViewState(minSx - r, minSy - r, maxSx + r, maxSy + r, bounds, 0.9));
    },
  }));

  // 出演者ドラッグ／画面移動（背景ドラッグ or Shift+ドラッグ）の状態
  const dragState = useRef(null);

  const clientToContentPoint = useCallback((clientX, clientY) => {
    const svg = svgRef.current;
    const group = viewGroupRef.current;
    if (!svg || !group) return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = group.getScreenCTM(); // ズーム・パンを含めた「画面→コンテンツ座標」の完全な変換
    if (!ctm) return null;
    return pt.matrixTransform(ctm.inverse());
  }, []);

  const startPan = (e) => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.setPointerCapture(e.pointerId);
    dragState.current = {
      mode: "pan",
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPanX: viewState.panX,
      startPanY: viewState.panY,
      moved: false,
    };
  };

  // Shift＋空白ドラッグ＝矩形範囲選択。空白の通常ドラッグ＝画面移動（従来通り）。
  const startRectSelect = (e) => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.setPointerCapture(e.pointerId);
    const loc = clientToContentPoint(e.clientX, e.clientY);
    if (!loc) return;
    dragState.current = {
      mode: "rectSelect",
      pointerId: e.pointerId,
      startContent: { x: loc.x, y: loc.y },
    };
    setRectSelectBox({ x1: loc.x, y1: loc.y, x2: loc.x, y2: loc.y });
  };

  const handleBackgroundPointerDown = (e) => {
    if (e.shiftKey) {
      startRectSelect(e);
    } else {
      startPan(e);
    }
  };

  const handlePointerDown = (e, performerId) => {
    e.stopPropagation();
    if (locked) return; // 再生中は出演者のドラッグ・選択操作を無効化（誤操作防止）。zoom/panは背景側の操作なので影響しない
    if (e.shiftKey) {
      // Shift＋クリック：選択への追加・解除（ドラッグは開始しない）
      onToggleSelect(performerId);
      return;
    }
    const svg = svgRef.current;
    if (!svg) return;
    svg.setPointerCapture(e.pointerId);

    // 既に複数選択中で、その中の1人をドラッグする場合は選択全員をまとめて移動する。
    // それ以外（未選択 or 単独選択）の場合はクリックした本人だけを選択し直す。
    const isMultiMember = selectedIdSet.has(performerId) && selectedIds.length > 1;
    if (!isMultiMember) {
      onSelect(performerId);
    }
    const dragIds = isMultiMember ? selectedIds : [performerId];
    const initialPositions = {};
    dragIds.forEach((id) => {
      if (placements[id]) initialPositions[id] = { x: placements[id].x, y: placements[id].y };
    });
    const loc = clientToContentPoint(e.clientX, e.clientY);
    const anchorStart = loc ? { x: fromScreenX(loc.x), y: fromScreenY(loc.y) } : { x: 0, y: 0 };
    dragState.current = {
      mode: "performer",
      pointerId: e.pointerId,
      ids: dragIds,
      initialPositions,
      anchorStart,
      moved: false,
    };
    // ドラッグ開始＝履歴のバッチ開始（この後の pointermove は履歴を増やさず、
    // pointerup で確定したときに1件の履歴としてまとめる）
    onDragStart();
  };

  // 通過点（waypoint）のドラッグ開始。出演者ドラッグと同じ dragState ステートマシンに
  // "waypoint" モードを追加する形で実装し、履歴のバッチ開始/終了（onDragStart/onDragEnd＝
  // App側のbeginWorkBatch/endWorkBatch）もそのまま再利用する。これにより、通常の出演者
  // ドラッグと全く同じ「1回のドラッグ＝1件のUndo履歴」という挙動になる。
  // waypointHandle.members（1件＝単独編集／複数件＝グループ編集）の「現在位置」を
  // initialWaypoints として記録し、出演者の複数選択ドラッグ（onDragGroup）と同じ
  // 「アンカーからの相対移動量（dx, dy）を全員に同じだけ適用する」方式にすることで、
  // 各waypoint同士の相対位置を維持したままグループ全体を平行移動できるようにする。
  const handleWaypointPointerDown = (e) => {
    e.stopPropagation();
    if (locked || !waypointHandle) return; // 再生中、または編集対象が無い場合は何もしない
    const svg = svgRef.current;
    if (!svg) return;
    svg.setPointerCapture(e.pointerId);
    const initialWaypoints = {};
    waypointHandle.members.forEach((m) => {
      initialWaypoints[m.performerId] = { x: m.x, y: m.y };
    });
    const loc = clientToContentPoint(e.clientX, e.clientY);
    const anchorStart = loc ? { x: fromScreenX(loc.x), y: fromScreenY(loc.y) } : { x: 0, y: 0 };
    dragState.current = {
      mode: "waypoint",
      pointerId: e.pointerId,
      fromSlideId: waypointHandle.fromSlideId,
      initialWaypoints,
      anchorStart,
      moved: false,
    };
    onDragStart();
  };

  const handlePointerMove = (e) => {
    const st = dragState.current;
    if (!st || st.pointerId !== e.pointerId) return;

    if (st.mode === "pan") {
      const svg = svgRef.current;
      if (!svg) return;
      const ctm = svg.getScreenCTM(); // ズームを含まない「viewBox→画面」の基準倍率
      if (!ctm || !ctm.a) return;
      const dxClient = e.clientX - st.startClientX;
      const dyClient = e.clientY - st.startClientY;
      if (!st.moved && (Math.abs(dxClient) > 3 || Math.abs(dyClient) > 3)) st.moved = true;
      onViewStateChange({
        panX: st.startPanX + dxClient / ctm.a,
        panY: st.startPanY + dyClient / ctm.d,
      });
      return;
    }

    if (st.mode === "rectSelect") {
      const loc = clientToContentPoint(e.clientX, e.clientY);
      if (!loc) return;
      setRectSelectBox({ x1: st.startContent.x, y1: st.startContent.y, x2: loc.x, y2: loc.y });
      return;
    }

    if (st.mode === "waypoint") {
      // 通過点ドラッグ（単独／グループ共通）：アンカー（ドラッグ開始位置）からの
      // 連続的な移動量（dx, dy）を求め、各出演者の「ドラッグ開始時点のwaypoint」に
      // 同じdx, dyを加算してからそれぞれ独立にsnapHalfで0.5単位へスナップする。
      // 開始時点のwaypointは常に0.5単位グリッド上にあるため、同じ連続delta加算後に
      // 個別スナップしても、出演者同士の相対位置（0.5単位の整数倍の差）は厳密に保たれる。
      // 舞台上だけでなく袖・舞台奥待機エリアにも制限なく移動できる
      // （出演者ドラッグと同様、エリア境界チェックは行わない）。
      const loc = clientToContentPoint(e.clientX, e.clientY);
      if (!loc) return;
      const curX = fromScreenX(loc.x);
      const curY = fromScreenY(loc.y);
      const dx = curX - st.anchorStart.x;
      const dy = curY - st.anchorStart.y;
      if (!st.moved && (Math.abs(dx) > 0.02 || Math.abs(dy) > 0.02)) st.moved = true;
      if (!st.moved) return;
      const updates = Object.keys(st.initialWaypoints).map((performerId) => {
        const init = st.initialWaypoints[performerId];
        return { performerId, x: snapHalf(init.x + dx), y: snapHalf(init.y + dy) };
      });
      onWaypointDrag(st.fromSlideId, updates);
      return;
    }

    // performer（単独 or 複数）ドラッグ：最初につかんだ人からの相対移動量を
    // 選択中の全員に同じだけ適用する（1人選択時は従来通りの単独移動と同じ結果になる）。
    // 実際にドラッグで動いた場合のみ更新する（単純なクリックだけで無駄な履歴を残さないため）。
    const loc = clientToContentPoint(e.clientX, e.clientY);
    if (!loc) return;
    const curX = fromScreenX(loc.x);
    const curY = fromScreenY(loc.y);
    const dx = curX - st.anchorStart.x;
    const dy = curY - st.anchorStart.y;
    if (!st.moved && (Math.abs(dx) > 0.02 || Math.abs(dy) > 0.02)) st.moved = true;
    if (!st.moved) return;
    onDragGroup(st.ids, dx, dy, st.initialPositions, false);
  };

  const handlePointerUp = (e) => {
    const st = dragState.current;
    if (!st || st.pointerId !== e.pointerId) return;

    if (st.mode === "pan") {
      if (!st.moved) onSelect(null); // 動かさずに離した＝背景クリック＝選択解除
      dragState.current = null;
      return;
    }

    if (st.mode === "rectSelect") {
      const box = rectSelectBox;
      dragState.current = null;
      setRectSelectBox(null);
      if (!box) return;
      const minX = Math.min(box.x1, box.x2);
      const maxX = Math.max(box.x1, box.x2);
      const minY = Math.min(box.y1, box.y2);
      const maxY = Math.max(box.y1, box.y2);
      if (maxX - minX < 2 && maxY - minY < 2) return; // ほぼ動いていない＝何もしない
      const ids = performers
        .filter((p) => {
          const pos = placements[p.id];
          if (!pos) return false;
          const sx = toScreenX(pos.x);
          const sy = toScreenY(pos.y);
          return sx >= minX && sx <= maxX && sy >= minY && sy <= maxY;
        })
        .map((p) => p.id);
      onRectSelect(ids);
      return;
    }

    if (st.mode === "waypoint") {
      dragState.current = null;
      // ドラッグ終了＝履歴のバッチ確定。動いていなければ present が baseline のままなので、
      // endBatch側で自動的に履歴は増えない（出演者ドラッグと同じ挙動）。
      onDragEnd();
      return;
    }

    const loc = clientToContentPoint(e.clientX, e.clientY);
    if (loc && st.moved) {
      const curX = fromScreenX(loc.x);
      const curY = fromScreenY(loc.y);
      const dx = curX - st.anchorStart.x;
      const dy = curY - st.anchorStart.y;
      onDragGroup(st.ids, dx, dy, st.initialPositions, true);
    }
    dragState.current = null;
    // ドラッグ終了＝履歴のバッチ確定（開始時点の状態と現在の状態の差分をまとめて1件の履歴にする。
    // 実際には動いていなければ present が baseline と同一のままなので、endBatch側で自動的に
    // 履歴は増えない）
    onDragEnd();
  };

  // 出演者表示サイズ v1・PART G：baseFigureRadius（従来通りの基準値）から、マーカー用
  // （displayScaleそのまま）と名前用（performerNameScaleという緩やかな値）を別々に導出する。
  // 座標変換（stageViewToScreenX/Y等）には一切関与しないため、出演者のx/y位置は変わらない。
  const baseFigureRadius = clamp(UNIT_CM * 0.28, 18, 34);
  const figureRadius = baseFigureRadius * performerDisplayScale;
  const nameFontRadius = baseFigureRadius * performerNameScale;
  const sizeComp = figureMinSizeCompensation(viewState.zoom);
  const groupTransform = viewGroupTransform(viewState, bounds);

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${bounds.totalW} ${bounds.totalH}`}
      width={width}
      height={height}
      style={{
        display: "block",
        margin: "0 auto",
        maxWidth: "100%",
        maxHeight: "100%",
        touchAction: "none",
        // ステージ操作エリア全体でブラウザ標準のテキスト選択を無効化する（9章）。
        // 出演者・waypointのpointer操作（onPointerDown等）自体には影響しない
        // （user-selectはテキスト選択のみを抑止し、pointer/clickイベントは別物のため）。
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      // pointercancel（ブラウザが何らかの理由でpointerジェスチャーを打ち切った場合。例：OS標準の
      // 別ジェスチャーへの割り込みなど）でもonPointerLeaveと同じ後始末を行い、dragState.currentが
      // 残留したまま次のドラッグに古い開始位置が引き継がれることを防ぐ（7章の保険。
      // ドラッグ計算ロジック自体は一切変更しない）。
      onPointerCancel={handlePointerUp}
      onPointerDown={handleBackgroundPointerDown}
    >
      <g ref={viewGroupRef} transform={groupTransform}>
        {/* ---- 背景レイヤー（操作対象外）----
            ステージ枠・グリッド・目盛り（数字含む）・センターライン・待機エリア枠と
            ラベル・方向ラベルなど、明示的な操作を必要としない要素をまとめて1つの
            <g> に収める。pointerEvents="none" により、この中の個々の要素は一切
            pointerイベントのターゲットにならず、クリック／ドラッグは常にその下（実質的に
            親の<svg>＝handleBackgroundPointerDown）へそのまま通過する。これにより、
            Shift＋ドラッグの矩形選択や背景ドラッグ（pan）の起点が、目盛り数字や
            「舞台奥」などのラベルの上を通っても一切揺らがなくなる（既存のpan/矩形選択の
            ロジック自体は変更しない）。
            userSelectは念のためこの<g>にも重ねて指定する（SVGの<style>継承だけに頼らず、
            要素ごとにも明示しておくことで、ブラウザ差異による青いテキスト選択を防ぐ）。 */}
        <g pointerEvents="none" style={{ userSelect: "none", WebkitUserSelect: "none" }}>
          {/* 舞台床 */}
          <rect
            x={stageLeftPx}
            y={stageTopPx}
            width={stageRightPx - stageLeftPx}
            height={stageBottomPx - stageTopPx}
            fill={THEME.stageFloor}
            stroke={THEME.gridLine}
            strokeWidth={2}
          />
          {/* グリッド */}
          {gridLines.map((l) => (
            <line
              key={l.key}
              x1={l.x1}
              y1={l.y1}
              x2={l.x2}
              y2={l.y2}
              stroke={l.whole ? THEME.gridLine : THEME.gridLineHalf}
              strokeWidth={l.whole ? 1.2 : 0.7}
            />
          ))}
          {/* 舞台中央線（横方向の目印） */}
          <line
            x1={toScreenX(0)}
            y1={stageTopPx}
            x2={toScreenX(0)}
            y2={stageBottomPx}
            stroke={THEME.accent}
            strokeOpacity={0.35}
            strokeWidth={1.4}
            strokeDasharray="3 4"
          />

          {/* 座標目盛り：舞台前方＝横方向（中央0、上手・下手へ1,2,3…） */}
          <g>
            {axisTicks.xTicks.map((t) => (
              <g key={t.key}>
                <line
                  x1={t.screenX}
                  y1={stageBottomPx}
                  x2={t.screenX}
                  y2={stageBottomPx + 8}
                  stroke={t.isCenter ? THEME.accent : THEME.textDim}
                  strokeWidth={t.isCenter ? 1.6 : 1}
                />
                <text
                  x={t.screenX}
                  y={stageBottomPx + 21}
                  fill={t.isCenter ? THEME.accent : THEME.textDim}
                  fontSize={12}
                  fontWeight={t.isCenter ? "bold" : "normal"}
                  textAnchor="middle"
                >
                  {t.label}
                </text>
              </g>
            ))}
          </g>

          {/* 座標目盛り：左右両端＝奥行方向（舞台前0から奥へ1,2,3…） */}
          <g>
            {axisTicks.yTicks.map((t) => (
              <g key={t.key}>
                <line x1={stageLeftPx - 8} y1={t.screenY} x2={stageLeftPx} y2={t.screenY} stroke={THEME.textDim} strokeWidth={1} />
                <text x={stageLeftPx - 13} y={t.screenY + 4} fill={THEME.textDim} fontSize={11} textAnchor="end">
                  {t.label}
                </text>
                <line x1={stageRightPx} y1={t.screenY} x2={stageRightPx + 8} y2={t.screenY} stroke={THEME.textDim} strokeWidth={1} />
                <text x={stageRightPx + 13} y={t.screenY + 4} fill={THEME.textDim} fontSize={11} textAnchor="start">
                  {t.label}
                </text>
              </g>
            ))}
          </g>

          {/* センターマーク：ステージの縦横中央（x=0, y=stage.depth/2）。十字のみ、出演者より背面に描画。
              ズームアウト時も視認できるよう sizeComp で逆スケールをかける。 */}
          <g>
            <line
              x1={toScreenX(0) - 11 * sizeComp}
              y1={toScreenY(stage.depth / 2)}
              x2={toScreenX(0) + 11 * sizeComp}
              y2={toScreenY(stage.depth / 2)}
              stroke={THEME.accent}
              strokeOpacity={0.8}
              strokeWidth={2.2 * sizeComp}
            />
            <line
              x1={toScreenX(0)}
              y1={toScreenY(stage.depth / 2) - 11 * sizeComp}
              x2={toScreenX(0)}
              y2={toScreenY(stage.depth / 2) + 11 * sizeComp}
              stroke={THEME.accent}
              strokeOpacity={0.8}
              strokeWidth={2.2 * sizeComp}
            />
          </g>

          {/* 待機エリア（下手袖・上手袖・舞台奥） */}
          {showBackstage && (
            <g>
              <rect
                x={toScreenX(zones.stageLeft.xMin)}
                y={stageTopPx}
                width={toScreenX(zones.stageLeft.xMax) - toScreenX(zones.stageLeft.xMin)}
                height={stageBottomPx - stageTopPx}
                fill={THEME.panelBg2}
                stroke={THEME.borderSoft}
                strokeDasharray="5 4"
                strokeWidth={1.5}
              />
              <text
                x={(toScreenX(zones.stageLeft.xMin) + toScreenX(zones.stageLeft.xMax)) / 2}
                y={stageTopPx + 22}
                fill={THEME.textDim}
                fontSize={16}
                textAnchor="middle"
              >
                下手袖
              </text>

              <rect
                x={toScreenX(zones.stageRight.xMin)}
                y={stageTopPx}
                width={toScreenX(zones.stageRight.xMax) - toScreenX(zones.stageRight.xMin)}
                height={stageBottomPx - stageTopPx}
                fill={THEME.panelBg2}
                stroke={THEME.borderSoft}
                strokeDasharray="5 4"
                strokeWidth={1.5}
              />
              <text
                x={(toScreenX(zones.stageRight.xMin) + toScreenX(zones.stageRight.xMax)) / 2}
                y={stageTopPx + 22}
                fill={THEME.textDim}
                fontSize={16}
                textAnchor="middle"
              >
                上手袖
              </text>

              <rect
                x={toScreenX(zones.upstageBackstage.xMin)}
                y={toScreenY(zones.upstageBackstage.yMax)}
                width={toScreenX(zones.upstageBackstage.xMax) - toScreenX(zones.upstageBackstage.xMin)}
                height={toScreenY(zones.upstageBackstage.yMin) - toScreenY(zones.upstageBackstage.yMax)}
                fill={THEME.panelBg2}
                stroke={THEME.borderSoft}
                strokeDasharray="5 4"
                strokeWidth={1.5}
              />
              <text
                x={(toScreenX(zones.upstageBackstage.xMin) + toScreenX(zones.upstageBackstage.xMax)) / 2}
                y={toScreenY(zones.upstageBackstage.yMax) + 20}
                fill={THEME.textDim}
                fontSize={16}
                textAnchor="middle"
              >
                舞台奥待機エリア
              </text>
            </g>
          )}

          {/* 方向ラベル（待機エリアのさらに外側に表示） */}
          {(() => {
            const leftEdge = showBackstage ? toScreenX(zones.stageLeft.xMin) : stageLeftPx;
            const rightEdge = showBackstage ? toScreenX(zones.stageRight.xMax) : stageRightPx;
            const topEdge = showBackstage ? toScreenY(zones.upstageBackstage.yMax) : stageTopPx;
            return (
              <>
                <text x={leftEdge - 22} y={(stageTopPx + stageBottomPx) / 2} fill={THEME.textDim} fontSize={20} textAnchor="middle" transform={`rotate(-90 ${leftEdge - 22} ${(stageTopPx + stageBottomPx) / 2})`}>
                  下手（−）
                </text>
                <text x={rightEdge + 22} y={(stageTopPx + stageBottomPx) / 2} fill={THEME.textDim} fontSize={20} textAnchor="middle" transform={`rotate(90 ${rightEdge + 22} ${(stageTopPx + stageBottomPx) / 2})`}>
                  上手（＋）
                </text>
                <text x={(stageLeftPx + stageRightPx) / 2} y={topEdge - 18} fill={THEME.textDim} fontSize={20} textAnchor="middle">
                  舞台奥
                </text>
              </>
            );
          })()}
        </g>

        {/* 移動軌跡（表示専用レイヤー）：出演者より背面・非インタラクティブに描画する。
            transitionPaths は App 側で computeTransitionPaths により毎回計算し直された
            「開始→終了」の経路情報（表示専用）で、slides/placementsは一切変更しない。
            tp.type === "curve" の出演者は、保存済みのwaypoint（work.transitionPaths、
            舞台座標）を同じ toScreenX/toScreenY で画面座標へ変換し、二次ベジェのSVGパスとして
            描画する（toScreenX/toScreenYは平行移動＋拡大縮小のみのアフィン変換のため、
            舞台座標上のベジェ曲線をそのまま画面座標へ変換しても数学的に同じ曲線になる）。
            矢印は終点付近の進行方向（曲線なら waypoint→終点の向き）を使う。
            選択中の出演者の軌跡だけ太く・濃く強調し、それ以外は主張しすぎないよう薄く表示する。 */}
        {transitionPaths && transitionPaths.length > 0 && (
          <g pointerEvents="none">
            {transitionPaths.map((tp) => {
              const performer = performers.find((p) => p.id === tp.id);
              const color = (performer && performer.color) || THEME.textDim;
              const emphasized = selectedIdSet.has(tp.id);
              const x1 = toScreenX(tp.from.x);
              const y1 = toScreenY(tp.from.y);
              const x2 = toScreenX(tp.to.x);
              const y2 = toScreenY(tp.to.y);
              const arrowSize = emphasized ? 12 : 8;
              const isCurve = tp.type === "curve" && tp.waypoint;
              const wx = isCurve ? toScreenX(tp.waypoint.x) : null;
              const wy = isCurve ? toScreenY(tp.waypoint.y) : null;
              // 矢印の向き：直線ならfrom→to、曲線ならwaypoint→to（終点付近の接線方向に近似）
              const arrowPts = isCurve
                ? trajectoryArrowPoints(wx, wy, x2, y2, arrowSize)
                : trajectoryArrowPoints(x1, y1, x2, y2, arrowSize);
              return (
                <g key={`traj-${tp.id}`} opacity={emphasized ? 0.9 : 0.35}>
                  <circle cx={x1} cy={y1} r={emphasized ? 4 : 2.5} fill={color} />
                  {isCurve ? (
                    <path
                      d={`M ${x1} ${y1} Q ${wx} ${wy} ${x2} ${y2}`}
                      fill="none"
                      stroke={color}
                      strokeWidth={emphasized ? 3 : 1.5}
                      strokeLinecap="round"
                    />
                  ) : (
                    <line
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      stroke={color}
                      strokeWidth={emphasized ? 3 : 1.5}
                      strokeLinecap="round"
                    />
                  )}
                  {arrowPts && <polygon points={arrowPts} fill={color} />}
                </g>
              );
            })}
          </g>
        )}

        {/* 通過点（waypoint）編集ハンドル：曲線設定を持つ出演者を選択している場合のみ、
            軌跡レイヤーの上に表示してドラッグできるようにする。出演者本体・通常の軌跡と
            区別できるよう、ひし形＋出演者と異なる色（アクセントカラー）にする。
              ・selectedIds.length === 1（waypointHandle.mode === "single"）：
                その出演者自身のwaypoint位置に、塗りつぶしのひし形を1つ表示（従来通り）。
              ・selectedIds.length >= 2（waypointHandle.mode === "group"）：
                選択中のcurve出演者のwaypointの平均位置に、単独編集と区別できるよう
                外枠のみのひし形＋破線の丸で囲んだ「グループハンドル」を1つだけ表示する。
                ドラッグすると選択中の全waypointが相対位置を保ったまま平行移動する。
            再生中（locked）はドラッグを無効化する。 */}
        {waypointHandle && !locked && (
          <g
            transform={`translate(${toScreenX(waypointHandle.handleX)} ${toScreenY(waypointHandle.handleY)})`}
            style={{ cursor: "grab" }}
            onPointerDown={(e) => handleWaypointPointerDown(e)}
          >
            {waypointHandle.mode === "group" ? (
              <>
                <circle r={13} fill="none" stroke={THEME.accent} strokeWidth={1.5} strokeDasharray="3 3" />
                <polygon
                  points="0,-9 9,0 0,9 -9,0"
                  fill={THEME.panelBg}
                  stroke={THEME.accent}
                  strokeWidth={2}
                />
              </>
            ) : (
              <polygon
                points="0,-9 9,0 0,9 -9,0"
                fill={THEME.accent}
                stroke="#141318"
                strokeWidth={1.5}
              />
            )}
          </g>
        )}

        {/* 出演者名 v1.1・PART I・J：出演者マーカー（丸＋番号）より必ず背面になるよう、
            「全出演者の名前」を1つのレイヤーとしてマーカーより先に描画する（2-pass描画）。
            以前は出演者ごとに「マーカー→名前」をまとめて描いていたため、performers配列の
            並び順次第で、後に描画される出演者の名前が、先に描画された別の出演者のマーカー・
            番号の上に乗ってしまうことがあった。名前レイヤーを丸ごと先に描き切ってから
            マーカーレイヤーを描くことで、縦に密集していても「丸＋番号は常に最前面」になる
            （PART I：出演者番号の可読性を名前より優先するという最重要ルール）。
            fontSize・Y offsetはgetPerformerNameDisplayMetrics()（Canvas Export側と共通）で
            算出し、SVGとCanvasで見た目の比率がズレないようにする（PART E・F）。 */}
        {showPerformerNames &&
          performers.map((p) => {
            const pos = placements[p.id];
            if (!pos) return null;
            const name = getPerformerName(p);
            if (!name) return null;
            const metrics = getPerformerNameDisplayMetrics(name, nameFontRadius, figureRadius);
            if (!metrics) return null;
            const sx = toScreenX(pos.x);
            const sy = toScreenY(pos.y);
            return (
              <g key={`name-${p.id}`} transform={`translate(${sx} ${sy}) scale(${sizeComp})`}>
                <text
                  x={0}
                  y={metrics.offsetY}
                  textAnchor="middle"
                  fontSize={metrics.fontSize}
                  fontWeight="bold"
                  fill={THEME.text}
                  stroke={THEME.bg}
                  strokeWidth={2.5}
                  paintOrder="stroke"
                  pointerEvents="none"
                  style={{ userSelect: "none", WebkitUserSelect: "none" }}
                >
                  {metrics.text}
                </text>
              </g>
            );
          })}

        {/* 出演者（マーカー＋番号レイヤー。名前レイヤーより必ず後＝前面に描画される＝PART I・J） */}
        {performers.map((p) => {
          const pos = placements[p.id];
          if (!pos) return null;
          const sx = toScreenX(pos.x);
          const sy = toScreenY(pos.y);
          const warn = isBeyondAllAreas(pos, zones) || overlapIds.has(p.id);
          return (
            <g
              key={p.id}
              transform={`translate(${sx} ${sy})`}
              style={{ cursor: locked ? "default" : "grab" }}
              onPointerDown={(e) => handlePointerDown(e, p.id)}
            >
              <g transform={`scale(${sizeComp})`}>
                {/* 人物マーカー表示の改善・PART A：出演者カラーでベタ塗りした丸＋中央に白い数字、
                    という単一デザインをTopPerformerMarker（TopView・FormationThumbnail・
                    平面図PNGの3箇所で共有）へ集約した。選択枠・警告枠（円のリング）・番号の
                    フォントサイズ計算（1〜2桁はperformerNumberFontSize、3桁以降はさらに縮小）は
                    すべてTopPerformerMarker内部の共通ロジックに任せ、ここでは二重実装しない。 */}
                <TopPerformerMarker color={p.color} selected={selectedIdSet.has(p.id)} warn={warn} radius={figureRadius} number={p.number} />
                {warn && (
                  <text x={figureRadius * 0.9} y={-figureRadius * 0.9} fontSize={20} textAnchor="middle">
                    ⚠
                  </text>
                )}
              </g>
            </g>
          );
        })}

        {/* Shift＋空白ドラッグ中の矩形範囲選択の表示 */}
        {rectSelectBox && (
          <rect
            x={Math.min(rectSelectBox.x1, rectSelectBox.x2)}
            y={Math.min(rectSelectBox.y1, rectSelectBox.y2)}
            width={Math.abs(rectSelectBox.x2 - rectSelectBox.x1)}
            height={Math.abs(rectSelectBox.y2 - rectSelectBox.y1)}
            fill={THEME.accent}
            fillOpacity={0.12}
            stroke={THEME.accent}
            strokeWidth={1.5}
            strokeDasharray="4 3"
            pointerEvents="none"
          />
        )}
      </g>
    </svg>
  );
});

// ------------------------------------------------------------------
// 構成一覧 v1.1：FormationThumbnail（読み取り専用の小さな平面図）
// ------------------------------------------------------------------
// 構成一覧のカード用に、座標変換（stageViewToScreenX / stageViewToScreenY）と
// 出演者の描画パーツ（TopPerformerMarker・performerNumberFontSize）をそのまま再利用し、
// 座標変換・出演者描画のロジックを二重実装しない（3章・25章）。
// pointer event・drag・zoom・pan・selectedIds・waypoint編集は一切持たない、完全な読み取り専用の
// pure render component（useState/useEffect/イベントリスナーを一切持たない＝5章・24章）。
// 移動軌跡・waypoint・選択枠・警告枠・zoom UI・目盛りの数字・操作ボタンは表示しない（6章）。
//
// v1.1：boundsは「出演者配置がすべて収まる範囲」を動的に計算するcomputeStageViewBounds
// （通常のTopView用）ではなく、ステージ本体の実寸（stage.width / stage.depth）＋固定の
// paddingだけで決まるcomputeFormationThumbnailBoundsを使う（1〜4章・8章）。これにより：
//   ・出演者の位置に関わらず、常にステージ本体の4辺（左端・右端・前端・奥端）が
//     必ず表示範囲に入る（1章）。
//   ・boundsが出演者配置に依存しないため、構成ごとに配置が違っても全カードで
//     完全に同じ画角（同じzoom率）になる（2章・D〜G章のテスト対象）。
// 待機エリア（下手袖・上手袖・舞台奥）はfit対象に含めないため、そこにいる出演者は
// 表示範囲の外に出ることがある。<svg>要素は仕様上デフォルトでoverflow:hiddenのため、
// 特別なclip pathを追加しなくても自然にクリップされる（6・7章：ステージ本体の
// フォーメーション比較を優先する）。
// stage/zonesは呼び出し側（構成一覧モーダル）が現在のwork.stage・computeZones(stage)から
// 渡す。サムネイル自体は画像を生成・保存せず、渡されたplacementsから毎回SVGとして描画するだけ
// なので、構成名変更・配置変更・構成追加/削除/並べ替え・Copy/Pasteのいずれにも自動的に追従する
// （16〜21章）。
function FormationThumbnail({ stage, zones, performers, placements }) {
  const halfW = stage.width / 2;
  const bounds = computeFormationThumbnailBounds(stage);
  const toScreenX = (xUnits) => stageViewToScreenX(bounds, xUnits);
  const toScreenY = (yUnits) => stageViewToScreenY(bounds, yUnits);
  const stageLeftPx = toScreenX(-halfW);
  const stageRightPx = toScreenX(halfW);
  const stageTopPx = toScreenY(stage.depth);
  const stageBottomPx = toScreenY(0);
  const figureRadius = clamp(UNIT_CM * 0.28, 18, 34);

  // 9・10章：細かい目盛り数字は出さず、ステージ本体の中央線（x=0）と、比較の助けになる
  // 程度の少数の整数単位の縦グリッド線だけを薄く表示する。TopViewのgridLines（0.5単位まで
  // 含む編集用の細かいグリッド）はそのまま流用せず、ここでは構成比較用の簡易版として
  // 独立に（ただし同じtoScreenXを使って）少数の線だけを算出する。
  const gridXUnits = [];
  for (let i = 1; i < halfW; i += 1) gridXUnits.push(i, -i);

  return (
    <svg
      viewBox={`0 0 ${bounds.totalW} ${bounds.totalH}`}
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid meet"
      style={{ display: "block", pointerEvents: "none", overflow: "hidden" }}
    >
      {/* 待機エリア（下手袖・上手袖・舞台奥）：fit対象には含めないため、はみ出す分は
          <svg>のデフォルトのoverflow:hiddenで自然にクリップされる（6・7章）。 */}
      <rect
        x={toScreenX(zones.stageLeft.xMin)}
        y={stageTopPx}
        width={toScreenX(zones.stageLeft.xMax) - toScreenX(zones.stageLeft.xMin)}
        height={stageBottomPx - stageTopPx}
        fill={THEME.panelBg2}
        stroke={THEME.borderSoft}
        strokeWidth={1}
      />
      <rect
        x={toScreenX(zones.stageRight.xMin)}
        y={stageTopPx}
        width={toScreenX(zones.stageRight.xMax) - toScreenX(zones.stageRight.xMin)}
        height={stageBottomPx - stageTopPx}
        fill={THEME.panelBg2}
        stroke={THEME.borderSoft}
        strokeWidth={1}
      />
      <rect
        x={toScreenX(zones.upstageBackstage.xMin)}
        y={toScreenY(zones.upstageBackstage.yMax)}
        width={toScreenX(zones.upstageBackstage.xMax) - toScreenX(zones.upstageBackstage.xMin)}
        height={toScreenY(zones.upstageBackstage.yMin) - toScreenY(zones.upstageBackstage.yMax)}
        fill={THEME.panelBg2}
        stroke={THEME.borderSoft}
        strokeWidth={1}
      />
      {/* 舞台本体 */}
      <rect
        x={stageLeftPx}
        y={stageTopPx}
        width={stageRightPx - stageLeftPx}
        height={stageBottomPx - stageTopPx}
        fill={THEME.stageFloor}
        stroke={THEME.gridLine}
        strokeWidth={2}
      />
      {/* 簡易グリッド（整数単位の縦線）：目盛り数字ラベルは付けない（9章） */}
      {gridXUnits.map((x) => (
        <line
          key={`grid-${x}`}
          x1={toScreenX(x)}
          y1={stageTopPx}
          x2={toScreenX(x)}
          y2={stageBottomPx}
          stroke={THEME.gridLineHalf}
          strokeWidth={1}
        />
      ))}
      {/* センターライン（x=0）：左右対称フォーメーションを見分けやすくする（10章） */}
      <line
        x1={toScreenX(0)}
        y1={stageTopPx}
        x2={toScreenX(0)}
        y2={stageBottomPx}
        stroke={THEME.textDim}
        strokeWidth={1.2}
        opacity={0.6}
      />
      {/* 出演者：色付き○＋白い数字のみ。選択枠・警告枠・軌跡・waypointは表示しない（6章）。
          人物マーカー表示の改善・PART A・7章：TopViewと同じTopPerformerMarkerを共有する。 */}
      {performers.map((p) => {
        const pos = placements[p.id];
        if (!pos) return null;
        const sx = toScreenX(pos.x);
        const sy = toScreenY(pos.y);
        return (
          <g key={p.id} transform={`translate(${sx} ${sy})`}>
            <TopPerformerMarker color={p.color} selected={false} warn={false} radius={figureRadius} number={p.number} />
          </g>
        );
      })}
    </svg>
  );
}

// ==================================================================
// PNG Export v1
// ==================================================================
// 「現在選択中の1構成」を、共有用の1枚のPNG画像として書き出す機能。
// 目的（1章）：編集パネル・操作バー・ボタン等を含む画面キャプチャは一切行わず、
// 作品データから「共有用の構成画像」を独立して生成する（3章）。
//
// 責務を3層へ分離する（15・24章：将来のPNG一括出力・PDF出力・構成一覧からの出力・
// 共有資料レイアウトへ差し替え・拡張しやすくするため）。
//   React/App
//     ↓
//   buildFormationExportModel()   … 「何を出力するか」を決めるpure helper。
//                                    音楽位置計算・Auto Chain計算・transition path決定・
//                                    stage area判定など“作品ロジック”はここに集約し、
//                                    既存のresolveSlideMusicPosition・computeTransitionPaths・
//                                    effectiveTransitionPathConfigをそのまま再利用する
//                                    （二重実装しない＝5・15・17章）。
//     ↓
//   renderFormationExportToCanvas() … 「どうPNGへ描画するか」だけを担当するpure関数。
//                                    渡された完成済みExport Modelを描くだけで、作品ロジックは
//                                    一切新しく実装しない（17章）。将来
//                                    renderFormationExportToPDF() に差し替えても、
//                                    buildFormationExportModel()側は変更不要（24章）。
//     ↓
//   downloadCanvasAsPng()          … Canvas→Blob→ダウンロードだけを担当する。
//
// これら3関数はいずれもReact hooksやwork/slidesを直接参照しない、独立した純粋関数
// （drawTopPerformerMarker等の描画専用サブルーチンも同様）。App側の呼び出しハンドラ
// （handleExportPngのようなuseCallback）だけがReact stateを読み、そこから引数として渡す。

// 出力解像度は固定（18章：編集画面のCSS zoom率・表示サイズに一切依存しない）。
const EXPORT_PNG_WIDTH = 1600;
const EXPORT_PNG_HEIGHT = 1000;
// Export品質改善・PART B：Canvasの「論理サイズ」（レイアウト計算に使う座標系）は
// EXPORT_PNG_WIDTH/HEIGHTのまま変更せず、Canvas要素の実ピクセル密度だけをこの倍率で
// 引き上げる（見た目を拡大するのではなく、同じ見た目をより高密度に描画する）。
// renderFormationExportToCanvas側でcanvas.width/heightにこの倍率を掛け、
// ctx.scale(EXPORT_PIXEL_RATIO, EXPORT_PIXEL_RATIO)を最初に1回適用するだけで、
// 以降の描画コード（drawFormationExportHeader・renderTopFormationExport・
// renderAudienceFormationExport・出演者マーカー・名前・移動軌跡など）は一切変更不要になる
// （PART C：logical coordinateとphysical pixel resolutionの分離）。
// まずは2x固定とし、品質選択UIやそれ以上の倍率は今回追加しない（PART E）。
const EXPORT_PIXEL_RATIO = 2;
// Export品質改善・PART F〜H：PNG/ZIP/PDF Export時だけ、移動軌跡（線・曲線・矢印）の
// 透明度を下げ、出演者マーカー＋番号を視覚的な主役にする。編集画面side（TopView SVGの
// 移動軌跡）は完全に別実装であり、この定数はCanvas Export専用（renderTopFormationExport・
// renderAudienceFormationExport）にしか影響しない。
const EXPORT_TRAJECTORY_ALPHA = 0.45;
// Export表示倍率 v1・PART B：auto-fit（＝100%）を基準に、ユーザーがExport Center上で
// 微調整できる「構図倍率」。EXPORT_PIXEL_RATIO（Canvasの実ピクセル密度＝解像度）とは
// 完全に別概念で、こちらは「同じ解像度のまま、構図をどれだけ寄せる／引くか」を決める。
const EXPORT_DISPLAY_SCALE_MIN = 0.9;
const EXPORT_DISPLAY_SCALE_MAX = 1.1;
const EXPORT_DISPLAY_SCALE_STEP = 0.05;
const EXPORT_DISPLAY_SCALE_DEFAULT = 1;
// 9章：PNGでは出演者番号を画面表示（FormationThumbnailのfigureRadius*1.35）より
// 少し大きくする。丸マーカーの数字サイズ計算式自体（topMarkerNumberFontSize）は変更しない。
const EXPORT_PERFORMER_NUMBER_BASE_SCALE = 1.7;

// ------------------------------------------------------------------
// buildFormationExportModel()：「何を出力するか」を決めるpure helper
// ------------------------------------------------------------------
// PNG Export v1.1・18〜20章：将来の「全構成」「選択した複数構成」一括出力
// （slides.map(slide => buildFormationExportModel(...)) 的な使い方）にそのまま使えるよう、
// 「今どの構成を編集しているか」を意味するApp側のcurrentSlideIndexという名前・概念は
// 一切受け取らない／参照しない。代わりに「対象のslideそのもの」と「そのslideIndex」を
// 独立した引数として受け取る、任意のslideに使えるpure functionにした。
//   slide / slideIndex / slides    出力対象の1構成（slideIndexはslides内での位置。
//                                   1-based番号表示・resolveSlideMusicPositionのAuto Chain
//                                   探索・次slide参照のいずれにも使う＝19・20章）
//   performers / stage / zones     出演者・ステージ・エリア定義（そのまま）
//   musicSections / transitionCounts  音楽位置計算（resolveSlideMusicPositionへそのまま渡す）
//   effectiveTransitionPathConfig  移動軌跡の実効設定（App側で既に計算済みのものをそのまま渡す。
//                                   ここで新しくスマート経路等を計算し直さない＝17章）
//   showTrajectory                 現在の「移動軌跡を表示」チェックボックスの状態（12章）
//   trajectoryMode                 UI Stability v1・PART C：軌跡の参照方向（"next"｜"previous"）。
//                                   編集画面の「次に／前に」トグルと同じ値をそのまま渡す。
// 戻り値（15章の例に準拠）：
//   { slideNumber, slideName, musicPosition, stage, zones, performers, placements, transitionPaths }
// 対象のslideが特定できない場合はnullを返す（23章：呼び出し側でエラー表示のみ行い、
// クラッシュしない）。
//
// PNG Export v1.2・PART E・24章：「Export Modelは作品データ、viewMode/showWaitingAreasは
// 描画方法」という分離方針に合わせ、v1.1にあった options（showWaitingAreas）引数と
// それによるperformers/transitionPathsの事前フィルタリングは、この関数から完全に取り除いた。
// buildFormationExportModel()は常に「その構成の全出演者・全placements・全移動軌跡」という
// “作品データそのもの”を返すだけにし、「待機エリアを表示するかどうか」という描画方法の
// 判断・フィルタリングは、renderFormationExportToCanvas()（正確にはその中のtop/audience
// レンダラー）側の責務に一本化した（PART Iで報告するv1.1バグの再発防止にもなる：
// 「ONにしたのにmodel側で既に消されている」ような食い違いが構造的に起きなくなる）。
function buildFormationExportModel({
  slide,
  slideIndex,
  slides,
  performers,
  stage,
  zones,
  musicSections,
  transitionCounts,
  effectiveTransitionPathConfig,
  showTrajectory,
  trajectoryMode,
  performerDisplayScale,
  showMusicTime, // Export音楽位置・音源内時間 v1：Export Centerの「音源内時間を表示」チェックボックスの値
}) {
  if (!slide || !Array.isArray(slides) || slideIndex == null || slideIndex < 0 || slideIndex >= slides.length) {
    return null;
  }

  // 10章：音楽位置は構成一覧と全く同じ方法（resolveSlideMusicPosition）で取得する。
  // 位置計算ロジックはここでは一切持たず、既存関数の戻り値を整形するだけ（二重実装しない）。
  const resolvedMusicPosition = resolveSlideMusicPosition(slides, slideIndex, musicSections, transitionCounts);
  const musicPosition = formatExportMusicPositionLabel(resolvedMusicPosition, musicSections, showMusicTime);

  // UI Stability & Bottom Navigation v1・PART C：軌跡消失regressionの根本原因は、ここが
  // 「対象構成→次構成」を自前でハードコードしており、編集画面が実際に使っている
  // getTrajectoryPlacements({slides, currentSlideIndex, mode})（"次に"/"前に"のトグルを
  // 反映する共通関数）を一切通していなかったことだった。trajectoryMode==="previous"
  // （「前に」表示中）の構成をPNG出力すると、画面には前の構成からの軌跡が見えているのに
  // PNGは常に「次の構成」を探しにいってしまい、最後の構成など次が無いケースでは軌跡が
  // 空になる（＝消えたように見える）食い違いが起きていた。
  // 修正：画面と全く同じgetTrajectoryPlacements()をそのまま再利用し、"次に"/"前に"のどちらでも
  // 画面と同じfromPlacements/toPlacements/fromSlideIdを得る（経路計算ロジック自体は
  // 一切複製しない＝12〜13章の方針を維持）。
  let transitionPaths = [];
  if (showTrajectory) {
    const ref = getTrajectoryPlacements({ slides, currentSlideIndex: slideIndex, mode: trajectoryMode });
    if (ref) {
      // 画面と全く同じ経路（直線／曲線／自動スマート経路／手動waypoint）にするため、
      // App側で既に計算済みのeffectiveTransitionPathConfigをそのまま参照する。
      const pathConfig = (effectiveTransitionPathConfig && effectiveTransitionPathConfig[ref.fromSlideId]) || null;
      transitionPaths = computeTransitionPaths(ref.fromPlacements || {}, ref.toPlacements || {}, pathConfig);
    }
  }

  return {
    slideNumber: slideIndex + 1,
    slideName: slide.name || "",
    musicPosition,
    stage,
    zones,
    // 出演者表示サイズ v1・PART N：Project全体で1つの表示設定をExport Modelにも含める
    // （未設定・不正値はgetPerformerDisplayScale側で既にPERFORMER_DISPLAY_SCALE_LARGeへ
    // フォールバック済みの値がここへ渡ってくる想定。呼び出し側で省略された場合の保険として
    // ここでも同じフォールバックを適用する）。
    performerDisplayScale: PERFORMER_DISPLAY_SCALES.includes(performerDisplayScale) ? performerDisplayScale : PERFORMER_DISPLAY_SCALE_LARGE,
    // PART D・18章：俯瞰PNGはFrontFigureと同じ身長(height)ベースでheightPxを算出するため、
    // 平面図PNGでは使わないheightもここで含めておく（Export Modelは「作品データ」全体を
    // 持つのが役割で、どのフィールドをrendererが使うかはrenderer側の責務＝24章）。
    performers: Array.isArray(performers)
      ? performers.map((p) => ({ id: p.id, number: p.number, color: p.color, height: p.height, name: getPerformerName(p) }))
      : [],
    placements: slide.placements || {},
    transitionPaths,
  };
}

// ------------------------------------------------------------------
// buildFormationExportModels()：複数slide分のExport Modelをまとめて作る薄いpure helper（21章）
// ------------------------------------------------------------------
// 今回（v1.1）はこの関数の呼び出し元（一括ダウンロードUI・ZIP・PDF等）はまだ実装しない
// （PART K）。あくまで将来の「全構成」「選択した複数構成」出力が、buildFormationExportModel()
// を書き換えずにそのまま使えることを確認するための薄いラッパーとして用意した。
//   slideIndices  出力したいslideのindex配列。省略時はslides全件（＝将来の「全構成」出力に相当）。
// 22章：常に「slides配列順」で並べる。slideIndicesに指定した順序（＝将来の「選択構成」機能で
// ユーザーが選択した順）には依存させない（重複指定・範囲外indexも安全に無視する）。
// 個々のmodel生成はbuildFormationExportModel()にそのまま委譲するだけで、ここに新しい
// 作品ロジックは一切追加しない。
function buildFormationExportModels({
  slideIndices,
  slides,
  performers,
  stage,
  zones,
  musicSections,
  transitionCounts,
  effectiveTransitionPathConfig,
  showTrajectory,
  trajectoryMode,
  performerDisplayScale,
  showMusicTime, // Export音楽位置・音源内時間 v1：buildFormationExportModelへそのまま伝播するだけ
}) {
  if (!Array.isArray(slides) || slides.length === 0) return [];
  const orderedIndices = Array.isArray(slideIndices)
    ? Array.from(new Set(slideIndices))
        .filter((i) => Number.isInteger(i) && i >= 0 && i < slides.length)
        .sort((a, b) => a - b)
    : slides.map((_, i) => i);
  return orderedIndices
    .map((slideIndex) =>
      buildFormationExportModel({
        slide: slides[slideIndex],
        slideIndex,
        slides,
        performers,
        stage,
        zones,
        musicSections,
        transitionCounts,
        effectiveTransitionPathConfig,
        showTrajectory,
        trajectoryMode,
        performerDisplayScale,
        showMusicTime,
      })
    )
    .filter((m) => m !== null);
}

// 構成一覧の音楽位置表示（formatFormationListMusicLabel）と同じ考え方で、
// resolveSlideMusicPosition()の結果を整形するだけのpure helper。表示文言だけは
// PNG共有資料向け（10・11章の例：「♫ 1曲目　12エイト目・5カウント目」「（自動）」の
// 小さな注記付き、未設定時は「♫ 音楽位置 未設定」）に変えているが、位置計算ロジック
// 自体は完全に共通（resolveSlideMusicPosition）のため二重実装ではない。
// Export音楽位置・音源内時間 v1：showMusicTime（Export Centerの「音源内時間を表示」チェック
// ボックスの値）がtrueの場合だけ、「｜ 1:39」のように末尾へ追記する。表示する時間は
// 「ユーザーが貼り付けた音楽ファイル全体の先頭を0:00とした絶対時間」＝
// musicAnchorToTimeSec(anchor, musicSections)の戻り値そのものであり、Music Sectionの
// startSec・countStartSecは一切差し引かない（新しい時間計算エンジンは持たず、既存の
// musicAnchorToTimeSec()を唯一の基準としてそのまま使う）。resolved.anchorは手動Anchor・
// Auto Chainどちらの結果でも同じ形のオブジェクトのため、Auto Chainの構成でも同じ経路で
// 時間表示の対象になる。showMusicTimeがfalse、またはmusicAnchorToTimeSecがnull/非有限値
// （参照先Section不明等）の場合は、音楽位置の表示自体は変えず、時間部分だけを追加しない。
function formatExportMusicPositionLabel(resolved, musicSections, showMusicTime) {
  if (!resolved || !resolved.anchor) {
    return {
      text: "♫ 音楽位置 未設定",
      sectionName: null,
      eighthNumber: null,
      countOffset: null,
      isManual: false,
      isUnset: true,
      absoluteTimeSec: null,
    };
  }
  const section = Array.isArray(musicSections) ? musicSections.find((s) => s.id === resolved.anchor.sectionId) || null : null;
  const sectionName = section ? section.name : "（不明な楽曲）";
  const base = `♫ ${sectionName}　${formatMusicAnchorEighthCountLabel(resolved.anchor.eighthNumber, resolved.anchor.countOffset)}`;
  // 11章：手動/自動を必ず強調する必要はないため、自動計算の場合だけ控えめな注記を添える。
  let text = resolved.isManual ? base : `${base}（自動）`;
  const absoluteTimeSec = showMusicTime ? musicAnchorToTimeSec(resolved.anchor, musicSections) : null;
  const hasValidAbsoluteTimeSec = absoluteTimeSec != null && Number.isFinite(absoluteTimeSec);
  if (showMusicTime && hasValidAbsoluteTimeSec) {
    text = `${text}　｜　${formatTime(absoluteTimeSec)}`;
  }
  return {
    text,
    sectionName,
    eighthNumber: resolved.anchor.eighthNumber,
    countOffset: resolved.anchor.countOffset,
    isManual: !!resolved.isManual,
    isUnset: false,
    absoluteTimeSec: hasValidAbsoluteTimeSec ? absoluteTimeSec : null,
  };
}

// ------------------------------------------------------------------
// 座標変換の一般化（5章）
// ------------------------------------------------------------------
// computeFormationThumbnailBounds() / stageViewToScreenX() / stageViewToScreenY() は
// 既存のまま一切変更・複製しない。これらはSVGのviewBox（preserveAspectRatio="xMidYMid meet"）
// による「コンテンツ座標系→自動フィット」を前提にしており、viewBox機構を持たないCanvasでは
// 同じ「はみ出さず・アスペクト比を保ったまま中央寄せでfitさせる」処理を自分で行う必要がある。
// これはFormationThumbnailのSVGが暗黙にやっていること（xMidYMid meet）を、Canvas向けに
// 「contentサイズ→viewportサイズへの拡大率とオフセット」という小さな一般的な幾何計算として
// 切り出しただけであり、ステージ固有の計算（bounds・エリア判定等）は一切含まない。
function computeContainFitTransform(contentW, contentH, viewportW, viewportH) {
  if (!(contentW > 0) || !(contentH > 0) || !(viewportW > 0) || !(viewportH > 0)) {
    return { scale: 1, offsetX: 0, offsetY: 0 };
  }
  const scale = Math.min(viewportW / contentW, viewportH / contentH);
  const offsetX = (viewportW - contentW * scale) / 2;
  const offsetY = (viewportH - contentH * scale) / 2;
  return { scale, offsetX, offsetY };
}

// Export表示倍率 v1・PART E・F：完成済みauto-fit（computeContainFitTransform()の結果）は
// 一切変更せず、その「後段」でユーザー指定の追加倍率（factor＝1.0が100%）を掛けるだけの
// pure helper。EXPORT_PIXEL_RATIO（Canvasの実ピクセル密度）とは完全に別概念で、
// こちらは「auto-fitされた構図そのものを、中心を保ったまま少し拡大／縮小する」ための
// 構図倍率（100%＝現在完成しているauto-fitと完全に同じ見え方）。
// viewport（stageAreaW×stageAreaH）の中心を固定点として、そこを基準にscale・offsetを
// 再計算する（左上基準の拡大縮小だと110%で右上へ寄ってしまうため、PART Fの「center維持」
// 要件を満たすには中心基準の計算が必須）。
//   screen = offset + scale * content という写像で、viewport中心 V/2 に対応する
//   content側の点 c = (V/2 - offset) / scale は倍率を変えても不変であってほしいので、
//   新しいoffset' = V/2 - (scale*factor) * c = V/2*(1-factor) + factor*offset となる。
function applyExportDisplayScale(fit, viewportW, viewportH, factor) {
  if (!factor || factor === 1) return fit;
  return {
    scale: fit.scale * factor,
    offsetX: (viewportW / 2) * (1 - factor) + factor * fit.offsetX,
    offsetY: (viewportH / 2) * (1 - factor) + factor * fit.offsetY,
  };
}

// PNG Export v1.1・PART A・1〜3章：奥行き方向の目盛りに使う値（整数のみ・0.25/0.5単位は
// 出さない）を計算するだけの小さな数値helper。TopViewの既存の奥行き目盛り（axisTicksの
// yTicks：0〜Math.floor(stage.depth)の整数列）と同じ考え方・同じ範囲を踏襲しているが、
// TopView本体（forwardRefコンポーネント内のuseMemo）は変更しない（既存機能維持のため）。
// ステージ座標変換そのもの（stageViewToScreenY等）は複製せず、呼び出し側がtoY()で
// 画面/Canvas座標へ変換する（このhelperは「何の値の目盛りを打つか」だけを決める）。
function computeDepthAxisTickValues(stageDepth) {
  if (!(stageDepth > 0)) return [0];
  const maxTick = Math.floor(stageDepth);
  const ticks = [];
  for (let j = 0; j <= maxTick; j += 1) ticks.push(j);
  return ticks;
}

// PNG Export v1.2・PART A・1章：横幅方向の目盛りに使う値（整数のみ）を計算する小さな数値
// helper。TopViewの既存の横方向目盛り（axisTicksのxTicks：中央0・Math.floor(halfW)まで
// 上手/下手それぞれへ）と全く同じ「センター=0、左右対称に増える」という定義・同じ範囲を
// 踏襲している（TopView本体は変更しない）。座標変換（stageViewToScreenX）は複製せず、
// 呼び出し側がtoX()で画面/Canvas座標へ変換する。
function computeWidthAxisTickValues(halfW) {
  if (!(halfW > 0)) return [0];
  const maxTick = Math.floor(halfW);
  const ticks = [];
  for (let i = -maxTick; i <= maxTick; i += 1) ticks.push(i);
  return ticks;
}

// PNG Export v1.2・PART B・11・12・14章：「待機エリアを表示」ON/OFFにおける出演者の
// 可視判定を1箇所に集約するpure helper。OverheadAudienceViewの既存visiblePerformersが
// 使っている判定（`pos.area === "stage" || pos.area == null`。null＝どのエリアにも
// 属さない範囲外の出演者は、待機エリアの一種ではなく「警告対象」なのでOFFでも隠さない）と
// 完全に同じ考え方を、平面図PNG・俯瞰PNGの両方で共有する。
function isPerformerVisibleForExport(pos, showWaitingAreas) {
  if (!pos) return false;
  if (showWaitingAreas) return true;
  return pos.area === "stage" || pos.area == null;
}

// ------------------------------------------------------------------
// ファイル名生成（20章）
// ------------------------------------------------------------------
function sanitizeExportFilenameName(name) {
  return String(name || "").trim().replace(/[\\/:*?"<>|]/g, "_");
}
function buildFormationExportFilename(slideNumber, slideName) {
  const num = String(Math.max(1, Math.round(slideNumber || 1))).padStart(3, "0");
  const safeName = sanitizeExportFilenameName(slideName);
  return safeName ? `formation_${num}_${safeName}.png` : `formation_${num}.png`;
}
// Export Center v1.1・PART B・10章：複数構成PNGをまとめるZIPのファイル名。個々のPNGファイル名
// （buildFormationExportFilename）と全く同じsanitizeExportFilenameName()を再利用し、
// 危険文字の除去ロジックを二重実装しない。Project名が空の場合は「formation」へfallbackする。
function buildFormationExportZipFilename(projectName) {
  const safeName = sanitizeExportFilenameName(projectName) || "formation";
  return `${safeName}_formation_png.zip`;
}
// Export Center v1.2：PDF出力のファイル名。ZIP名と全く同じsanitizeExportFilenameName()を
// 再利用し、危険文字の除去ロジックを二重実装しない（ZIP filename生成と同じ設計方針）。
function buildFormationExportPdfFilename(projectName) {
  const safeName = sanitizeExportFilenameName(projectName) || "formation";
  return `${safeName}_formation.pdf`;
}

// ------------------------------------------------------------------
// renderFormationExportToCanvas()：Export Modelを描画するだけの薄いディスパッチャ（17・24章）
// ------------------------------------------------------------------
// PNG Export v1.2・PART E：将来の複数構成/PDF出力を見据え、「Export Model（作品データ）」と
// 「描画方法（viewMode・showWaitingAreasという表示設定）」を明確に分離した。
//   renderFormationExportToCanvas(model, canvas, renderOptions)
//     renderOptions.viewMode           "top"（平面図・既定） | "audience"（俯瞰客席ビュー）
//     renderOptions.showWaitingAreas   待機エリア表示ON/OFF（既定true）
// buildFormationExportModel()自体はviewMode/showWaitingAreasを一切知らない「作品データ」の
// ままにし（24章）、この関数がviewModeに応じてrenderTopFormationExport() /
// renderAudienceFormationExport()へ処理を委譲するだけにする。Canvas 2D contextの取得に
// 失敗した場合はfalseを返す（23章）。
function renderFormationExportToCanvas(model, canvas, renderOptions) {
  if (!model || !canvas) return false;
  // Export品質改善・PART B・C：canvas要素自体の実ピクセルサイズはEXPORT_PIXEL_RATIO倍にするが、
  // 以降の描画はすべて従来通りEXPORT_PNG_WIDTH×EXPORT_PNG_HEIGHTの論理座標系のまま行う。
  // ctx.scale()をここで1回だけ適用することで、drawFormationExportHeader・
  // renderTopFormationExport・renderAudienceFormationExport以下のすべての描画コードは
  // 一切変更せずに高密度化される（構図・余白・文字サイズ・マーカーサイズ等は完全に維持）。
  canvas.width = EXPORT_PNG_WIDTH * EXPORT_PIXEL_RATIO;
  canvas.height = EXPORT_PNG_HEIGHT * EXPORT_PIXEL_RATIO;
  const ctx = canvas.getContext && canvas.getContext("2d");
  if (!ctx) return false;
  ctx.scale(EXPORT_PIXEL_RATIO, EXPORT_PIXEL_RATIO);

  const viewMode = renderOptions && renderOptions.viewMode === "audience" ? "audience" : "top";
  const showWaitingAreas = !renderOptions || renderOptions.showWaitingAreas !== false;
  // 出演者名 v1・9・14章：俯瞰客席ビューでは常に名前を表示しない（renderAudienceFormationExport
  // 側には一切渡さない）。平面図（top）の場合だけ、renderOptions.showPerformerNamesを反映する。
  const showPerformerNames = !!(renderOptions && renderOptions.showPerformerNames);
  // Export表示倍率 v1・PART G・H：auto-fit後の構図倍率（1.0＝100%）。平面図・俯瞰客席ビュー
  // どちらのrendererにも同じ値を渡す（それぞれのauto-fit計算・bounds計算自体は無変更）。
  const displayScale = renderOptions && typeof renderOptions.displayScale === "number" ? renderOptions.displayScale : 1;

  const PADDING = 40;
  const HEADER_H = 100;

  // 19章：背景は透明PNGにせず、既存THEMEをそのまま再利用したダークテーマの背景にする。
  ctx.fillStyle = THEME.bg;
  ctx.fillRect(0, 0, EXPORT_PNG_WIDTH, EXPORT_PNG_HEIGHT);

  // ヘッダー：構成番号・構成名・音楽位置（4・10・11・17章：top/audience両方の共通部分。
  // 今回タイトル周りのデザインは変更しない）。
  drawFormationExportHeader(ctx, model, PADDING);

  const stageAreaRect = {
    x: PADDING,
    y: PADDING + HEADER_H,
    w: EXPORT_PNG_WIDTH - PADDING * 2,
    h: EXPORT_PNG_HEIGHT - (PADDING + HEADER_H) - PADDING,
  };

  if (viewMode === "audience") {
    renderAudienceFormationExport(ctx, model, stageAreaRect, { showWaitingAreas, displayScale });
  } else {
    renderTopFormationExport(ctx, model, stageAreaRect, { showWaitingAreas, showPerformerNames, displayScale });
  }
  return true;
}

// top/audience共通のヘッダー（構成番号・構成名・音楽位置）描画。17章：デザインは維持。
function drawFormationExportHeader(ctx, model, PADDING) {
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillStyle = THEME.text;
  ctx.font = "bold 34px sans-serif";
  const titleText = `構成 ${model.slideNumber}　${model.slideName || ""}`.trim();
  ctx.fillText(titleText, PADDING, PADDING);

  ctx.fillStyle = model.musicPosition.isUnset ? THEME.textDim : THEME.accent;
  ctx.font = "22px sans-serif";
  ctx.fillText(model.musicPosition.text, PADDING, PADDING + 46);
}

// ------------------------------------------------------------------
// renderTopFormationExport()：平面図PNGの描画（PART A・B・C・15章の描画順に準拠）
// ------------------------------------------------------------------
// 描画順（15章）：1.背景（呼び出し元で塗布済み）→2.待機エリア→3.stage本体→4.縦grid→
// 5.横grid＋横幅/奥行き目盛り→6.センターライン→7.センター十字→8.移動軌跡→9.出演者→10.番号
function renderTopFormationExport(ctx, model, stageAreaRect, options) {
  const showWaitingAreas = !!(options && options.showWaitingAreas);
  const { x: stageAreaX, y: stageAreaY, w: stageAreaW, h: stageAreaH } = stageAreaRect;

  // 6・7・9章：出演者の配置によらず、常にステージ本体全体が収まる一定の画角にする。
  // PART I（原因報告・詳細は完了レポート参照）：showWaitingAreasがtrueの時だけzonesを
  // bounds計算へ含めることで、待機エリア（袖・舞台奥）が実際にCanvasの描画/クリップ範囲の
  // 中に入るようにする。v1.1のバグは、ON時でもこのzonesが一切渡されておらず、fit/clipが
  // 常にステージ本体だけの狭い範囲のままだったため、待機エリアの矩形・ラベル・出演者が
  // 常にクリップ範囲外に計算され、ONにしても実際には何も見えていなかったことが原因。
  const bounds = computeFormationThumbnailBounds(model.stage, showWaitingAreas ? model.zones : null);
  const fit = applyExportDisplayScale(
    computeContainFitTransform(bounds.totalW, bounds.totalH, stageAreaW, stageAreaH),
    stageAreaW,
    stageAreaH,
    options && options.displayScale
  );
  const toX = (xUnits) => stageAreaX + fit.offsetX + fit.scale * stageViewToScreenX(bounds, xUnits);
  const toY = (yUnits) => stageAreaY + fit.offsetY + fit.scale * stageViewToScreenY(bounds, yUnits);

  const halfW = model.stage.width / 2;
  const stageLeftPx = toX(-halfW);
  const stageRightPx = toX(halfW);
  const stageTopPx = toY(model.stage.depth);
  const stageBottomPx = toY(0);

  ctx.save();
  ctx.beginPath();
  ctx.rect(stageAreaX, stageAreaY, stageAreaW, stageAreaH);
  ctx.clip();

  // 描画順2：待機エリア（11・12章：showWaitingAreasがfalseの場合、枠・背景・ラベルを
  // 一切描画しない。13章：ステージ本体を主役にしたfit思想は維持しつつ、ONの場合は
  // 上のbounds修正により実際に待機エリアが見える位置に描かれる）。
  if (showWaitingAreas) {
    const drawZoneRect = (zone, label) => {
      const x1 = toX(zone.xMin);
      const x2 = toX(zone.xMax);
      const y1 = toY(zone.yMax);
      const y2 = toY(zone.yMin);
      ctx.fillStyle = THEME.panelBg2;
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
      ctx.strokeStyle = THEME.borderSoft;
      ctx.lineWidth = 1;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      if (label && x2 - x1 > 4 && y2 - y1 > 4) {
        ctx.fillStyle = THEME.textDim;
        ctx.font = "13px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(label, (x1 + x2) / 2, y1 + 6);
      }
    };
    drawZoneRect(model.zones.stageLeft, "下手袖");
    drawZoneRect(model.zones.stageRight, "上手袖");
    drawZoneRect(model.zones.upstageBackstage, "舞台奥");
  }

  // 描画順3：舞台本体
  ctx.fillStyle = THEME.stageFloor;
  ctx.fillRect(stageLeftPx, stageTopPx, stageRightPx - stageLeftPx, stageBottomPx - stageTopPx);
  ctx.strokeStyle = THEME.gridLine;
  ctx.lineWidth = 2;
  ctx.strokeRect(stageLeftPx, stageTopPx, stageRightPx - stageLeftPx, stageBottomPx - stageTopPx);

  // 描画順4・5：縦grid・横grid（PART A・4・5・6章：TopViewと同じ「ステージ本体の
  // 整数マス位置すべて」を対象にする。出演者より目立たないTHEME.gridLineHalfを使う）。
  ctx.strokeStyle = THEME.gridLineHalf;
  ctx.lineWidth = 1;
  for (let x = -halfW; x <= halfW; x += 1) {
    ctx.beginPath();
    ctx.moveTo(toX(x), stageTopPx);
    ctx.lineTo(toX(x), stageBottomPx);
    ctx.stroke();
  }
  for (let y = 0; y <= model.stage.depth; y += 1) {
    ctx.beginPath();
    ctx.moveTo(stageLeftPx, toY(y));
    ctx.lineTo(stageRightPx, toY(y));
    ctx.stroke();
  }

  // 横幅方向の目盛り（PART A・1・2章：TopViewのxTicksと同じ「中央=0、下手/上手へ1,2,3…」の
  // 定義をcomputeWidthAxisTickValues()で再利用。舞台手前側の少し外側（stageBottomPxの
  // すぐ下）に表示し、出演者・軌跡と重ならない位置にする）。
  ctx.textBaseline = "top";
  computeWidthAxisTickValues(halfW).forEach((v) => {
    const tx = toX(v);
    const isCenter = v === 0;
    ctx.strokeStyle = isCenter ? THEME.accent : THEME.textDim;
    ctx.lineWidth = isCenter ? 1.6 : 1;
    ctx.beginPath();
    ctx.moveTo(tx, stageBottomPx);
    ctx.lineTo(tx, stageBottomPx + 8);
    ctx.stroke();
    ctx.fillStyle = isCenter ? THEME.accent : THEME.textDim;
    ctx.font = isCenter ? "bold 12px sans-serif" : "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(String(Math.abs(v)), tx, stageBottomPx + 12);
  });

  // 奥行き方向の目盛り（PART A・3章：既存実装を維持。舞台前端=0という座標定義そのまま）。
  ctx.strokeStyle = THEME.textDim;
  ctx.fillStyle = THEME.textDim;
  ctx.font = "12px sans-serif";
  ctx.lineWidth = 1;
  ctx.textBaseline = "middle";
  computeDepthAxisTickValues(model.stage.depth).forEach((j) => {
    const ty = toY(j);
    ctx.beginPath();
    ctx.moveTo(stageLeftPx - 8, ty);
    ctx.lineTo(stageLeftPx, ty);
    ctx.stroke();
    ctx.textAlign = "right";
    ctx.fillText(String(j), stageLeftPx - 13, ty);

    ctx.beginPath();
    ctx.moveTo(stageRightPx, ty);
    ctx.lineTo(stageRightPx + 8, ty);
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.fillText(String(j), stageRightPx + 13, ty);
  });

  // 描画順6：センターライン（x=0）。通常gridより少し分かりやすく（7章）。
  ctx.strokeStyle = THEME.textDim;
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(toX(0), stageTopPx);
  ctx.lineTo(toX(0), stageBottomPx);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // 描画順7：センター十字（8章：TopViewの既存センターマークと同じx=0, y=stage.depth/2。
  // 出演者・軌跡より先に描くことで、出演者が重なっても常に出演者が上に見える＝7章）。
  {
    const centerX = toX(0);
    const centerY = toY(model.stage.depth / 2);
    const crossHalf = 11 * fit.scale;
    ctx.strokeStyle = THEME.accent;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(centerX - crossHalf, centerY);
    ctx.lineTo(centerX + crossHalf, centerY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(centerX, centerY - crossHalf);
    ctx.lineTo(centerX, centerY + crossHalf);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // 可視出演者（PART B・11・12・13・14章：showWaitingAreasに応じてここでフィルタする。
  // buildFormationExportModel()自体は常に全出演者を返すため、「何を見せるか」の判断は
  // このrenderer側に一本化されている＝v1.1バグの再発防止）。
  const visiblePerformers = model.performers.filter((p) => isPerformerVisibleForExport(model.placements[p.id], showWaitingAreas));
  const visibleIds = new Set(visiblePerformers.map((p) => p.id));
  const visibleTransitionPaths = model.transitionPaths.filter((p) => visibleIds.has(p.id));

  // 描画順8：移動軌跡。既に完成済みのvisibleTransitionPaths（直線／曲線／waypoint込み）を
  // そのまま描くだけ。ここで経路の種類やwaypointを新しく決定するロジックは一切無い（17章）。
  // Export品質改善・PART F〜I：Export時だけ移動軌跡の透明度を下げ、出演者マーカー＋番号を
  // 主役にする（編集画面のTopView SVG側は完全に別実装のため無変更）。ctx.save()/restore()で
  // 囲むことで、この透明度が後続の名前・マーカー描画へ絶対に漏れないようにする（PART I）。
  // 出演者表示サイズ v1・PART N：model.performerDisplayScaleをここでも同じ考え方で
  // フォールバックしつつ取得する。marker用（displayScaleそのまま）・名前用
  // （getPerformerNameScale()という緩やかな値）を別々のradiusとして導出するのは
  // TopView（SVG）と全く同じ式（二重実装しない＝PART E）。
  const performerDisplayScale = PERFORMER_DISPLAY_SCALES.includes(model.performerDisplayScale)
    ? model.performerDisplayScale
    : PERFORMER_DISPLAY_SCALE_LARGE;
  const performerNameScale = getPerformerNameScale(performerDisplayScale);
  const baseFigureRadius = clamp(UNIT_CM * 0.28, 18, 34) * fit.scale;
  const figureRadius = baseFigureRadius * performerDisplayScale;
  const nameFontRadius = baseFigureRadius * performerNameScale;
  ctx.save();
  ctx.globalAlpha = EXPORT_TRAJECTORY_ALPHA;
  visibleTransitionPaths.forEach((path) => {
    const performer = model.performers.find((p) => p.id === path.id);
    const color = (performer && performer.color) || THEME.textDim;
    const x1 = toX(path.from.x);
    const y1 = toY(path.from.y);
    const x2 = toX(path.to.x);
    const y2 = toY(path.to.y);
    const isCurve = path.type === "curve" && path.waypoint;
    const wx = isCurve ? toX(path.waypoint.x) : null;
    const wy = isCurve ? toY(path.waypoint.y) : null;

    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    if (isCurve) {
      ctx.quadraticCurveTo(wx, wy, x2, y2);
    } else {
      ctx.lineTo(x2, y2);
    }
    ctx.stroke();

    const arrowSize = 10;
    const arrowPts = isCurve
      ? trajectoryArrowPoints(wx, wy, x2, y2, arrowSize)
      : trajectoryArrowPoints(x1, y1, x2, y2, arrowSize);
    if (arrowPts) {
      const pts = arrowPts.split(" ").map((pair) => pair.split(",").map(Number));
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      ctx.lineTo(pts[1][0], pts[1][1]);
      ctx.lineTo(pts[2][0], pts[2][1]);
      ctx.closePath();
      ctx.fill();
    }
  });
  ctx.restore();

  // 出演者名 v1.1・PART I・K：「出演者番号は名前より必ず前面」というルールをCanvas Exportでも
  // 保証するため、SVG側（TopView）と同じ2-pass描画に統一する。
  //   PASS 1：全出演者の名前（options.showPerformerNamesがtrueの場合のみ）
  //   PASS 2：全出演者のマーカー＋番号（drawTopPerformerMarker）
  // 旧実装は「マーカー→名前」の順で、名前が常に全マーカーより前面に出てしまっていた
  // （＝どの出演者の名前も他の出演者の番号を覆いうるバグ）。名前レイヤーを先に描き切って
  // からマーカーレイヤーを描くことで、performers配列の並び順に関係なく「丸＋番号は常に
  // 最前面」になる。fontSize・Y offsetはgetPerformerNameDisplayMetrics()（SVG側と共通）で
  // 算出し、マーカー半径figureRadiusに対する比率をSVGと一致させる（PART E・F）。
  if (options && options.showPerformerNames) {
    ctx.textAlign = "center";
    // 出演者表示サイズ v1.3・PART E〜H：編集画面SVG側の見え方を正とする。SVG側の<text>には
    // dominantBaselineを指定しておらず、これはSVGのデフォルトである"alphabetic"（欧文の
    // ベースライン基準・文字の下端付近に基準点が来る）として描画されている。Canvas側は
    // 以前ctx.textBaseline="top"（文字の上端がoffsetYに来る）になっており、これがSVG側の
    // alphabetic基準と約1文字分弱ズレていた実機差の原因だった。
    // 修正方針：SVG側は一切変更せず、Canvas側をSVGのデフォルト挙動と同じ意味を持つ
    // ctx.textBaseline="alphabetic"へ合わせることで、offsetYの解釈をSVG側へ統一する
    // （getPerformerNameDisplayMetrics自体のoffsetY計算式は変更していない）。
    // 番号（drawTopPerformerMarker等）は元々SVG側もdominantBaseline="middle"で統一済みのため、
    // そちらのctx.textBaseline="middle"は変更しない（名前描画だけを直す）。
    ctx.textBaseline = "alphabetic";
    ctx.lineJoin = "round";
    visiblePerformers.forEach((p) => {
      const pos = model.placements[p.id];
      if (!pos) return;
      const name = getPerformerName(p);
      if (!name) return;
      const metrics = getPerformerNameDisplayMetrics(name, nameFontRadius, figureRadius);
      if (!metrics) return;
      const sx = toX(pos.x);
      const sy = toY(pos.y);
      ctx.font = `bold ${metrics.fontSize}px sans-serif`;
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = THEME.bg;
      ctx.strokeText(metrics.text, sx, sy + metrics.offsetY);
      ctx.fillStyle = THEME.text;
      ctx.fillText(metrics.text, sx, sy + metrics.offsetY);
    });
  }

  // 描画順9・10：出演者＋番号（drawTopPerformerMarker内で一緒に描く。8・9章）。
  // 名前レイヤーより後に描くことで、必ず名前より前面になる（PART I）。
  visiblePerformers.forEach((p) => {
    const pos = model.placements[p.id];
    if (!pos) return;
    const sx = toX(pos.x);
    const sy = toY(pos.y);
    drawTopPerformerMarker(ctx, sx, sy, p, figureRadius);
  });

  ctx.restore();
}

// 出演者1人分の「色付き丸＋中央の白い数字」をCanvasへ描く（人物マーカー表示の改善・PART A）。
// SVG版（TopPerformerMarker）と全く同じデザインルール（半径・番号フォントサイズ計算・
// 白文字・薄い外周線）を、Canvas APIで再現しただけの薄い関数。無理に1つの関数へ完全共通化は
// せず、比率・数値だけをTOP_MARKER_*定数・topMarkerNumberFontSize()で共有する（7章）。
function drawTopPerformerMarker(ctx, sx, sy, performer, figureRadius) {
  const color = performer.color || THEME.textDim;

  ctx.save();
  ctx.beginPath();
  ctx.arc(sx, sy, figureRadius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  const strokeWidth = Math.max(1, figureRadius * TOP_MARKER_STROKE_WIDTH_RATIO);
  if (strokeWidth > 0) {
    ctx.lineWidth = strokeWidth;
    ctx.strokeStyle = TOP_MARKER_STROKE_COLOR;
    ctx.stroke();
  }
  ctx.restore();

  // 9章：既存performerNumberFontSize()を内包するtopMarkerNumberFontSize()をそのまま再利用しつつ、
  // baseScaleにPNG向けの少し大きめの係数（EXPORT_PERFORMER_NUMBER_BASE_SCALE）を渡すだけで
  // 対応する（フォントサイズ計算ロジック自体は二重実装しない）。
  const numberFontSize = topMarkerNumberFontSize(figureRadius, performer.number, EXPORT_PERFORMER_NUMBER_BASE_SCALE);
  ctx.font = `bold ${numberFontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = TOP_MARKER_TEXT_COLOR;
  ctx.fillText(String(performer.number), sx, sy + figureRadius * 0.05);
}

// ------------------------------------------------------------------
// renderAudienceFormationExport()：俯瞰客席PNGの描画（PART D・18〜23章）
// ------------------------------------------------------------------
// 座標変換はOverheadAudienceViewと完全に共有するpure関数（computeAudienceViewBounds /
// projectAudiencePoint）だけを使い、俯瞰PNG専用の別の遠近計算は一切作らない（19章）。
// 描画順もOverheadAudienceViewの表示順序（床→下手/上手ラベル→Stage Guide→移動軌跡→
// 出演者→番号）をそのまま踏襲する。
// UI Stability & Bottom Navigation v1・PART F：以前（PNG Export v1.2）はここに
// 「横幅目盛り・奥行き目盛り・1マスgrid・センター十字は描かない」という制限があったが、
// 今回のPART D〜Fで方針が変わり、俯瞰PNGにも平面図と同じStage Guideを表示するよう
// 明示的に要求された。Stage Guideのgeometry定義（grid線・センターライン・センター十字・
// 幅/奥行き目盛りの「stage座標上の位置」）はbuildAudienceStageGuideGeometry(stage)へ
// 一本化し、画面側のOverheadAudienceViewと全く同じ関数を呼ぶ（二重実装しない）。
function renderAudienceFormationExport(ctx, model, stageAreaRect, options) {
  const showWaitingAreas = !!(options && options.showWaitingAreas);
  const { x: stageAreaX, y: stageAreaY, w: stageAreaW, h: stageAreaH } = stageAreaRect;

  // 18章：OverheadAudienceViewと同じcomputeAudienceViewBounds()で「舞台空間そのもの」の
  // 固定範囲（showWaitingAreasに応じてステージ本体のみ／下手袖+上手袖まで含む）を求め、
  // それをcomputeContainFitTransform()でCanvasの固定領域にcontain-fitさせるだけ。
  const bounds = computeAudienceViewBounds(model.stage, model.zones, showWaitingAreas);
  const fit = applyExportDisplayScale(
    computeContainFitTransform(bounds.totalW, bounds.totalH, stageAreaW, stageAreaH),
    stageAreaW,
    stageAreaH,
    options && options.displayScale
  );
  // 出演者表示サイズ v1.1・PART D・E：俯瞰客席ビューは「身長 小・中・大」でのみ人物サイズ・
  // 身長差を表現する設計のため、performerDisplayScale（平面図専用の表示設定）はここでは
  // 一切参照しない（v1で誤って反映していたheightPx/refHeightPxへの掛け算を撤去した）。
  // projectAudiencePoint()の結果（bounds空間のsx/sy）へ、Canvas用のfit変換だけを追加で
  // 掛け合わせる薄いラッパー。疑似遠近法の計算式そのものは一切変更していない。
  const project = (xUnits, yUnits) => {
    const p = projectAudiencePoint(bounds, model.stage.depth, xUnits, yUnits);
    return {
      sx: stageAreaX + fit.offsetX + fit.scale * p.sx,
      sy: stageAreaY + fit.offsetY + fit.scale * p.sy,
      scale: p.scale,
      opacity: p.opacity,
    };
  };

  const halfW = model.stage.width / 2;
  const stageFrontLeft = project(-halfW, 0);
  const stageFrontRight = project(halfW, 0);
  const stageBackLeft = project(-halfW, model.stage.depth);
  const stageBackRight = project(halfW, model.stage.depth);

  ctx.save();
  ctx.beginPath();
  ctx.rect(stageAreaX, stageAreaY, stageAreaW, stageAreaH);
  ctx.clip();

  // 描画順1：ステージ床（台形＝奥ほど狭い）。OverheadAudienceViewのpolygonと同じ4頂点。
  ctx.fillStyle = THEME.stageFloor;
  ctx.strokeStyle = THEME.gridLine;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(stageFrontLeft.sx, stageFrontLeft.sy);
  ctx.lineTo(stageFrontRight.sx, stageFrontRight.sy);
  ctx.lineTo(stageBackRight.sx, stageBackRight.sy);
  ctx.lineTo(stageBackLeft.sx, stageBackLeft.sy);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // 下手／上手ラベル（OverheadAudienceViewと同じステージ前端の位置）。
  ctx.fillStyle = THEME.textDim;
  ctx.font = "16px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText("下手", stageFrontLeft.sx, stageFrontLeft.sy + 10);
  ctx.fillText("上手", stageFrontRight.sx, stageFrontRight.sy + 10);

  // UI Stability & Bottom Navigation v1・PART D・E・F：Audience Stage Guide
  // （grid・センターライン・センター十字・幅目盛り・奥行き目盛り）。
  // geometry（「どこに線・目盛りが存在するか」というステージ座標上の定義）は
  // buildAudienceStageGuideGeometry(stage)を、画面側のOverheadAudienceViewと全く同じ
  // 関数でそのまま取得する（二重実装しない＝PART F）。ここではそのgeometryの各点を
  // 上のproject()（projectAudiencePoint()＋Canvas fit変換）で投影して描くだけ。
  // 描画順（E-5）：ステージ面の直後・移動軌跡／出演者より前。
  const stageGuide = buildAudienceStageGuideGeometry(model.stage);

  // grid（縦・横）：出演者より目立たせない、THEME.gridLineHalf相当の細い線。
  ctx.strokeStyle = THEME.gridLineHalf;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 0.8;
  stageGuide.gridVertical.forEach((seg) => {
    const a = project(seg.x1, seg.y1);
    const b = project(seg.x2, seg.y2);
    ctx.beginPath();
    ctx.moveTo(a.sx, a.sy);
    ctx.lineTo(b.sx, b.sy);
    ctx.stroke();
  });
  stageGuide.gridHorizontal.forEach((seg) => {
    const a = project(seg.x1, seg.y1);
    const b = project(seg.x2, seg.y2);
    ctx.beginPath();
    ctx.moveTo(a.sx, a.sy);
    ctx.lineTo(b.sx, b.sy);
    ctx.stroke();
  });
  ctx.globalAlpha = 1;

  // 幅目盛り（中央0、上手＋／下手−。y=0＝ステージ前端のライン上、画面側と同じ位置関係）。
  ctx.textBaseline = "top";
  stageGuide.widthTicks.forEach((t) => {
    const pos = project(t.x, t.y);
    const isCenter = t.value === 0;
    ctx.strokeStyle = isCenter ? THEME.accent : THEME.textDim;
    ctx.globalAlpha = isCenter ? 0.8 : 0.6;
    ctx.lineWidth = isCenter ? 1.2 : 0.8;
    ctx.beginPath();
    ctx.moveTo(pos.sx, pos.sy);
    ctx.lineTo(pos.sx, pos.sy + 5);
    ctx.stroke();
    ctx.globalAlpha = isCenter ? 0.9 : 0.65;
    ctx.fillStyle = isCenter ? THEME.accent : THEME.textDim;
    ctx.font = isCenter ? "bold 12px sans-serif" : "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(String(Math.abs(t.value)), pos.sx, pos.sy + 8);
  });
  ctx.globalAlpha = 1;

  // 奥行き目盛り（左右端＝x=±halfW。0＝舞台前端。平面図PNGと同様に左右両方へ表示する）。
  ctx.textBaseline = "middle";
  ctx.font = "12px sans-serif";
  stageGuide.depthTicks.forEach((t) => {
    const left = project(t.xLeft, t.y);
    const right = project(t.xRight, t.y);
    ctx.strokeStyle = THEME.textDim;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(left.sx - 5, left.sy);
    ctx.lineTo(left.sx, left.sy);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(right.sx, right.sy);
    ctx.lineTo(right.sx + 5, right.sy);
    ctx.stroke();
    ctx.globalAlpha = 0.65;
    ctx.fillStyle = THEME.textDim;
    ctx.textAlign = "right";
    ctx.fillText(String(t.value), left.sx - 9, left.sy);
    ctx.textAlign = "left";
    ctx.fillText(String(t.value), right.sx + 9, right.sy);
  });
  ctx.globalAlpha = 1;

  // センターライン（x=0）・センター十字（x=0, y=stage.depth/2）。平面図と全く同じ
  // stage coordinateをproject()で投影しただけ（PART G：stage coordinateとして一致）。
  {
    const a = project(stageGuide.centerLine.x1, stageGuide.centerLine.y1);
    const b = project(stageGuide.centerLine.x2, stageGuide.centerLine.y2);
    ctx.strokeStyle = THEME.textDim;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(a.sx, a.sy);
    ctx.lineTo(b.sx, b.sy);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const c = project(stageGuide.centerCross.x, stageGuide.centerCross.y);
    ctx.strokeStyle = THEME.accent;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(c.sx - 9, c.sy);
    ctx.lineTo(c.sx + 9, c.sy);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(c.sx, c.sy - 9);
    ctx.lineTo(c.sx, c.sy + 9);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // 可視出演者・可視軌跡（PART B・14章と同じisPerformerVisibleForExport()を再利用。
  // buildFormationExportModel()自体は常に全出演者を返すため、「何を見せるか」の判断は
  // top/audience両rendererで共通のこの一つの関数に一本化されている）。
  const visiblePerformers = model.performers.filter((p) => isPerformerVisibleForExport(model.placements[p.id], showWaitingAreas));
  const visibleIds = new Set(visiblePerformers.map((p) => p.id));
  const visibleTransitionPaths = model.transitionPaths.filter((p) => visibleIds.has(p.id));

  // 描画順2：移動軌跡（OverheadAudienceViewと同じ「project()で投影した3点をそのまま
  // 二次ベジェとして描く」近似方式。矢印の算出もtrajectoryArrowPoints()を再利用する）。
  // Export品質改善・PART F〜I：固定値0.55ではなく、平面図Export側と共通のEXPORT_TRAJECTORY_ALPHAを
  // 使う（線・矢印とも同じ透明度＝PART H）。ctx.save()/restore()で囲み、この透明度が
  // 後続の出演者描画（各performerごとのopacity設定）へ漏れないようにする（PART I）。
  ctx.save();
  ctx.globalAlpha = EXPORT_TRAJECTORY_ALPHA;
  visibleTransitionPaths.forEach((path) => {
    const performer = model.performers.find((p) => p.id === path.id);
    const color = (performer && performer.color) || THEME.textDim;
    const fromP = project(path.from.x, path.from.y);
    const toP = project(path.to.x, path.to.y);
    const isCurve = path.type === "curve" && path.waypoint;
    const wpP = isCurve ? project(path.waypoint.x, path.waypoint.y) : null;

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(fromP.sx, fromP.sy);
    if (isCurve) {
      ctx.quadraticCurveTo(wpP.sx, wpP.sy, toP.sx, toP.sy);
    } else {
      ctx.lineTo(toP.sx, toP.sy);
    }
    ctx.stroke();

    const arrowSize = 9;
    const arrowPts = isCurve
      ? trajectoryArrowPoints(wpP.sx, wpP.sy, toP.sx, toP.sy, arrowSize)
      : trajectoryArrowPoints(fromP.sx, fromP.sy, toP.sx, toP.sy, arrowSize);
    if (arrowPts) {
      const pts = arrowPts.split(" ").map((pair) => pair.split(",").map(Number));
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      ctx.lineTo(pts[1][0], pts[1][1]);
      ctx.lineTo(pts[2][0], pts[2][1]);
      ctx.closePath();
      ctx.fill();
    }
  });
  ctx.restore();

  // 描画順3：出演者（奥から手前の順。OverheadAudienceViewのsortedと同じ並び方で、
  // PNGには選択状態が無いためselected分の並べ替えのみ省略している）。
  const sorted = visiblePerformers
    .map((p) => ({ p, pos: model.placements[p.id] }))
    .filter((v) => !!v.pos)
    .sort((a, b) => b.pos.y - a.pos.y);

  sorted.forEach(({ p, pos }) => {
    const { sx, sy, scale, opacity } = project(pos.x, pos.y);
    // heightPx：OverheadAudienceViewのp.height * scale * sizeCompと同じ考え方。PNGは
    // ズーム操作が無い固定画角のため、bounds空間→Canvas pxへのfit.scaleだけを追加で掛ける。
    const heightPx = (p.height || DEFAULT_PERFORMER_HEIGHT) * scale * fit.scale;
    // 身長 v2・PART E〜G：X方向（体格）の基準はDEFAULT_PERFORMER_HEIGHT固定で計算し、
    // 実際のp.heightによる横幅の変化を防ぐ（OverheadAudienceView・SVG版と同じ考え方）。
    const refHeightPx = DEFAULT_PERFORMER_HEIGHT * scale * fit.scale;
    ctx.globalAlpha = opacity;
    drawExportPerformerAudience(ctx, sx, sy, heightPx, p, getPlacementPose(pos), refHeightPx);
    ctx.globalAlpha = 1;
  });

  ctx.restore();
}

// 俯瞰客席PNG用、出演者1人分の人型シルエット＋胸の番号をCanvasへ描く。FrontFigure（SVG版）と
// 同じ比率（headR/shoulderY/hipY/torsoW/armW/legW/legGapの係数）をそのまま数値だけ踏襲する
// （8章：SVGコンポーネントそのものは呼び出せないため、見た目の参考にするだけ＝二重実装ではない）。
// 姿勢 v1.1：pose引数を追加。"kneeling"の場合はcomputeKneelingFigureGeometry()の戻り値を
// そのまま使うdrawExportPerformerKneeling()（Canvas版）へ委譲する（PART C：SVG版
// FrontFigureKneelingと完全に同じジオメトリ計算を共有）。
// 身長 v2：refHeightPx引数を追加。省略時はheightPxへフォールバックする（従来通りの動作）。
function drawExportPerformerAudience(ctx, sx, sy, heightPx, performer, pose, refHeightPx) {
  const H = heightPx;
  if (!(H > 0)) return;
  const R = refHeightPx != null ? refHeightPx : heightPx;
  const color = performer.color || THEME.textDim;

  if (pose === POSE_KNEELING) {
    drawExportPerformerKneeling(ctx, sx, sy, H, R, color);
  } else {
    drawExportPerformerStanding(ctx, sx, sy, H, R, color);
  }

  // 胸の番号：既存performerNumberFontSizeAudience()をそのまま再利用する（9章：フォント
  // サイズ計算ロジック自体は二重実装しない）。位置・幅はfrontFigureChestMetrics()で姿勢ごとに
  // 算出し、OverheadAudienceView（SVG版）の番号タグと同じ数値になるようにする。
  const { tagOffsetY, chestWidth } = frontFigureChestMetrics(H, pose, R);
  const fontSize = performerNumberFontSizeAudience(chestWidth, performer.number);
  const tagY = sy + tagOffsetY;
  ctx.save();
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = Math.max(1.5, fontSize * 0.1);
  ctx.strokeStyle = "rgba(0,0,0,0.7)";
  ctx.lineJoin = "round";
  ctx.strokeText(String(performer.number), sx, tagY);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(String(performer.number), sx, tagY);
  ctx.restore();
}

// standing人形のCanvas描画本体（既存drawExportPerformerAudienceの中身をそのまま関数化しただけで、
// 比率は一切変更していない＝6章）。身長 v2・PART E：X方向はR（refHeightPx基準）、Y方向はH
// （実際のheightPx基準）で分離した（SVG版FrontFigureと同じ考え方＝PART F）。
function drawExportPerformerStanding(ctx, sx, sy, H, R, color) {
  const headR = R * FIGURE_HEAD_R_RATIO;
  const headCy = -H + headR;
  const shoulderY = -H * 0.84;
  const hipY = -H * 0.46;
  const torsoW = R * FIGURE_TORSO_W_RATIO;
  const armW = R * FIGURE_ARM_W_RATIO;
  const legW = R * FIGURE_LEG_W_RATIO;
  const legGap = R * FIGURE_LEG_GAP_RATIO;
  const legH = H - Math.abs(hipY);
  const armH = Math.abs(hipY - shoulderY) * 0.95;

  ctx.save();
  ctx.translate(sx, sy);
  ctx.fillStyle = color;

  // 脚
  drawExportRoundRect(ctx, -legGap - legW, hipY, legW, legH, legW * 0.3);
  drawExportRoundRect(ctx, legGap, hipY, legW, legH, legW * 0.3);
  // 腕
  ctx.globalAlpha *= 0.9;
  drawExportRoundRect(ctx, -torsoW - armW, shoulderY, armW, armH, armW * 0.3);
  drawExportRoundRect(ctx, torsoW, shoulderY, armW, armH, armW * 0.3);
  ctx.globalAlpha /= 0.9;
  // 胴体
  ctx.beginPath();
  ctx.moveTo(-torsoW, shoulderY);
  ctx.lineTo(torsoW, shoulderY);
  ctx.lineTo(torsoW * 0.8, hipY);
  ctx.lineTo(-torsoW * 0.8, hipY);
  ctx.closePath();
  ctx.fill();
  // 頭
  ctx.beginPath();
  ctx.arc(0, headCy, headR, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = THEME.bg;
  ctx.stroke();

  ctx.restore();
}

// 片膝立ち人形のCanvas描画本体。FrontFigureKneeling（SVG版）と全く同じ
// computeKneelingFigureGeometry()の戻り値だけを使って描画する（PART 17：SVGとCanvasで
// 数値がバラバラにならないよう、ジオメトリ計算そのものを共通pure helperへ一本化した）。
function drawExportPerformerKneeling(ctx, sx, sy, H, R, color) {
  const { headR, headCy, shoulderY, hipY, torsoW, armW, armH, legW, hipXLong, hipXShort, shortLegEndY, diagEndX, diagEndY } =
    computeKneelingFigureGeometry(H, R);

  ctx.save();
  ctx.translate(sx, sy);
  ctx.strokeStyle = color;
  ctx.lineCap = "round";

  // 長い脚（画面左＝人形自身の右脚）：腰から床までまっすぐ伸びる1本のみ。
  ctx.lineWidth = legW;
  ctx.beginPath();
  ctx.moveTo(hipXLong, hipY);
  ctx.lineTo(hipXLong, 0);
  ctx.stroke();

  // 短い脚（画面右＝人形自身の左脚）：腰から床までの半分程度で止める1本＋その先の
  // 小さな斜めパーツ1本（後方へ折り畳まれた足の記号）。
  ctx.beginPath();
  ctx.moveTo(hipXShort, hipY);
  ctx.lineTo(hipXShort, shortLegEndY);
  ctx.stroke();
  ctx.lineWidth = legW * 0.9;
  ctx.beginPath();
  ctx.moveTo(hipXShort, shortLegEndY);
  ctx.lineTo(diagEndX, diagEndY);
  ctx.stroke();

  ctx.fillStyle = color;
  // 腕（ニュートラル）
  ctx.globalAlpha *= 0.9;
  drawExportRoundRect(ctx, -torsoW - armW, shoulderY, armW, armH, armW * 0.3);
  drawExportRoundRect(ctx, torsoW, shoulderY, armW, armH, armW * 0.3);
  ctx.globalAlpha /= 0.9;
  // 胴体
  ctx.beginPath();
  ctx.moveTo(-torsoW, shoulderY);
  ctx.lineTo(torsoW, shoulderY);
  ctx.lineTo(torsoW * 0.8, hipY);
  ctx.lineTo(-torsoW * 0.8, hipY);
  ctx.closePath();
  ctx.fill();
  // 頭
  ctx.beginPath();
  ctx.arc(0, headCy, headR, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = THEME.bg;
  ctx.stroke();

  ctx.restore();
}

// 角丸矩形の塗りつぶしだけを行う小さな汎用helper（drawExportPerformerAudienceの
// 脚・腕の描画で使う。r（角丸半径）はw/2・h/2を超えないようclampする）。
function drawExportRoundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
  ctx.fill();
}

// ------------------------------------------------------------------
// downloadCanvasAsPng()：Canvas→Blob→ダウンロードだけを担当（16章）
// ------------------------------------------------------------------
// 外部ライブラリを追加せず実装できるCanvas APIを第一候補として採用した（16章）。
// canvas.toBlob失敗時（23章）はonErrorコールバックへ委譲し、呼び出し側でUI表示する。
// Export Center v1・11章：複数PNGを「順番に」ダウンロードする際、1件ごとの完了を
// 呼び出し側がawaitできるよう、任意の第4引数onDone（成功/失敗どちらでも呼ばれる）を追加した。
// 既存の呼び出し（onDoneを渡さない）は一切動作を変えない後方互換の拡張。
function downloadCanvasAsPng(canvas, filename, onError, onDone) {
  try {
    canvas.toBlob((blob) => {
      if (!blob) {
        if (onError) onError(new Error("PNG画像の生成に失敗しました。"));
        if (onDone) onDone(false);
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // ダウンロード開始前にURLが破棄されるブラウザ差異を避けるため、少し遅延させてrevokeする。
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (onDone) onDone(true);
    }, "image/png");
  } catch (err) {
    if (onError) onError(err);
    if (onDone) onDone(false);
  }
}

// canvasToPngBlob()：Canvas→PNG Blobへの変換だけを担当するPromise版helper（Export Center
// v1.1・PART B・13章）。canvas.toBlob()自体をPromise化しただけの薄いラッパーで、ZIP生成
// （複数Blobをまとめる必要がある処理）から使う。単体PNG出力（1枚だけの場合）は、既に安定して
// 動いているdownloadCanvasAsPng()をそのまま使い続け、無理に書き換えない（13章の方針通り）。
function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("PNG画像の生成に失敗しました。"));
          return;
        }
        resolve(blob);
      }, "image/png");
    } catch (err) {
      reject(err);
    }
  });
}

// downloadBlob()：任意のBlobを1回のa.click()でダウンロードする汎用helper（Export Center
// v1.1・PART B）。downloadCanvasAsPng()の「Blob→URL→<a>→click→revoke」の部分と同じ考え方だが、
// 入力がCanvasではなく既に出来上がったBlob（ZIP等）である点だけが異なる。安定して動いている
// downloadCanvasAsPng()自体の内部実装は書き換えず、ZIPダウンロード専用の小さな関数として
// 独立させた（12・13章：既存Export基盤を書き換えすぎない）。
function downloadBlob(blob, filename, onError) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    if (onError) onError(err);
  }
}

// ------------------------------------------------------------------
// 俯瞰客席ビュー（客席後方 / 2階席あたりから見下ろした疑似遠近法）
// ------------------------------------------------------------------
// PERSPECTIVE は「カメラ設定」に相当するパラメータをひとまとめにしたもの。
// 将来、カメラの高さ・角度・画角などを画面から調整できる本格的な
// PerspectiveView に発展させる際は、この定数（または同形の state）を
// project() に渡すだけで済むように設計してある。
const PERSPECTIVE = {
  depthScaleMin: 0.55, // 一番奥での人物サイズの縮小率
  widthScaleMin: 0.68, // 一番奥でのステージ横幅の圧縮率（台形パース）
  liftPerDepthUnit: 26, // 奥へ1単位進むごとに画面上へ持ち上がるpx量
  opacityMin: 0.55, // 一番奥での不透明度
};

// 俯瞰客席ビューの「100%表示」基準となる横方向の範囲（ステージ座標系・単位のまま）を、
// 出演者の配置に一切依存せず、舞台・待機エリアそのものの固定形状から計算する。
//   showWaitingAreas = false : ステージ本体のみを基準にする
//   showWaitingAreas = true  : ステージ本体 + 下手袖 + 上手袖（＝舞台奥待機エリアと同じ横幅）
//                              の固定された全領域を基準にする
// 各エリアの人数（0人でも100人でも）や、出演者が袖⇔ステージのどちらにいるかによって
// この範囲が変化することはない。将来、カメラ位置や画角を調整可能にする場合も、
// この関数だけを差し替えれば済むようにしてある。
function computeAudienceReferenceBounds(stage, zones, showWaitingAreas) {
  const halfW = stage.width / 2;
  if (!showWaitingAreas) {
    return { minXUnits: -halfW, maxXUnits: halfW };
  }
  return {
    minXUnits: Math.min(-halfW, zones.stageLeft.xMin),
    maxXUnits: Math.max(halfW, zones.stageRight.xMax),
  };
}

// PNG Export v1.2・PART D・18章：俯瞰客席ビューの「100%表示」基準（bounds）を計算する
// pure関数。OverheadAudienceView内に元々あった同名のuseMemoの中身を、React hooksへ一切
// 依存しない形でそのまま切り出しただけ（数式・依存する値は完全に同一＝挙動は変更しない）。
// PNG Exportの俯瞰レンダラーがOverheadAudienceViewと全く同じ画角の計算をそのまま
// 再利用できるようにするための共通化（19章：俯瞰PNG専用の別の遠近座標計算を作らない）。
function computeAudienceViewBounds(stage, zones, showWaitingAreas) {
  const ref = computeAudienceReferenceBounds(stage, zones, showWaitingAreas);
  const minX = ref.minXUnits * UNIT_CM;
  const maxX = ref.maxXUnits * UNIT_CM;
  const leftMargin = 80;
  const rightMargin = 80;
  const bottomMargin = 70;
  const topMargin = 70 + stage.depth * PERSPECTIVE.liftPerDepthUnit + 60;
  return {
    minX,
    maxX,
    leftMargin,
    rightMargin,
    topMargin,
    bottomMargin,
    totalW: maxX - minX + leftMargin + rightMargin,
    totalH: 175 + topMargin + bottomMargin,
  };
}

// PNG Export v1.2・PART D・18章：俯瞰客席ビューの疑似遠近法投影 project(xUnits, yUnits) を
// pure関数として切り出したもの。OverheadAudienceView内のuseCallback版と完全に同じ計算式
// （centerXcm・floorY・depthFactor・PERSPECTIVE定数の使い方も含めて数式は一切変更していない）。
// bounds（computeAudienceViewBoundsの結果）とstage.depthだけを引数に取る純粋関数にすることで、
// OverheadAudienceView（画面表示）とPNG Exportの俯瞰レンダラーの両方が、同じ関数を通して
// 常に同一の投影結果を得られるようにする（＝俯瞰PNGの出演者位置が既存Viewと必ず一致する）。
function projectAudiencePoint(bounds, stageDepth, xUnits, yUnits) {
  const centerXcm = (bounds.minX + bounds.maxX) / 2;
  const floorY = bounds.totalH - bounds.bottomMargin;
  const t = clamp(yUnits / Math.max(stageDepth, 1), -0.4, 1.6);
  const tClamped = clamp(t, 0, 1);
  const scale = lerp(1, PERSPECTIVE.depthScaleMin, tClamped) - Math.max(0, t - 1) * 0.15;
  const widthScale = lerp(1, PERSPECTIVE.widthScaleMin, tClamped);
  const xCm = xUnits * UNIT_CM;
  const sx = bounds.leftMargin + (centerXcm + (xCm - centerXcm) * widthScale - bounds.minX);
  const sy = floorY - t * (stageDepth * PERSPECTIVE.liftPerDepthUnit);
  const opacity = 1 - tClamped * (1 - PERSPECTIVE.opacityMin);
  return { sx, sy, scale: Math.max(0.15, scale), opacity };
}

// ------------------------------------------------------------------
// UI Stability & Bottom Navigation v1・PART D/E/F：Audience Stage Guideのgeometry共通化
// ------------------------------------------------------------------
// 俯瞰客席ビュー（画面：OverheadAudienceView）と俯瞰PNG（renderAudienceFormationExport）の
// 両方から使う「grid・センターライン・センター十字・幅目盛り・奥行き目盛り」を、
// “ステージ座標上の”幾何定義だけを返すpure関数として1箇所にまとめる。
// ここでは一切、画面座標・Canvas座標・projectAudiencePoint()を呼ばない
// （PART E：「Stage座標→projectAudiencePoint()→俯瞰画面座標」という一本化された流れに
// するため、座標変換はすべて呼び出し側に委ねる）。
//   ・grid（E-1）：平面図PNG（renderTopFormationExport）のgrid loopと全く同じ範囲・刻み
//     （-halfW〜halfWの全整数x、0〜stage.depthの全整数y）にする＝PART G「同じstage設定なら
//     平面図と俯瞰でgridの本数が一致する」を、ループの定義そのものを揃えることで保証する。
//   ・センターライン／センター十字（E-2）：平面図と全く同じstage coordinate（x=0の全奥行き、
//     およびx=0, y=stage.depth/2）を使う。
//   ・幅目盛り／奥行き目盛り（E-3・E-4）：値の算出は既存のcomputeWidthAxisTickValues() /
//     computeDepthAxisTickValues()をそのまま再利用し、ここでは新しく計算し直さない
//     （二重実装しない）。位置情報（幅目盛りは奥行き0のライン上、奥行き目盛りは
//     左右端＝x=±halfWのライン上）だけをここで補う。
function buildAudienceStageGuideGeometry(stage) {
  const halfW = stage.width / 2;
  const depth = stage.depth;

  const gridVertical = [];
  for (let x = -halfW; x <= halfW; x += 1) {
    gridVertical.push({ x1: x, y1: 0, x2: x, y2: depth });
  }
  const gridHorizontal = [];
  for (let y = 0; y <= depth; y += 1) {
    gridHorizontal.push({ x1: -halfW, y1: y, x2: halfW, y2: y });
  }

  const centerLine = { x1: 0, y1: 0, x2: 0, y2: depth };
  const centerCross = { x: 0, y: depth / 2 };

  const widthTicks = computeWidthAxisTickValues(halfW).map((value) => ({ value, x: value, y: 0 }));
  const depthTicks = computeDepthAxisTickValues(depth).map((value) => ({
    value,
    y: value,
    xLeft: -halfW,
    xRight: halfW,
  }));

  return { gridVertical, gridHorizontal, centerLine, centerCross, widthTicks, depthTicks };
}

const OverheadAudienceView = forwardRef(function OverheadAudienceView(
  {
    stage,
    zones,
    performers,
    placements,
    selectedIds,
    onSelect,
    onToggleSelect,
    overlapIds,
    showWaiting,
    viewState,
    onViewStateChange,
    width,
    height,
    locked,
    transitionPaths,
  },
  ref
) {
  const svgRef = useRef(null);
  const viewGroupRef = useRef(null);
  const halfW = stage.width / 2;
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  // 待機エリアの出演者を表示するかどうか（範囲外＝警告対象は常に表示する）
  const visiblePerformers = useMemo(
    () =>
      performers.filter((p) => {
        const pos = placements[p.id];
        if (!pos) return false;
        if (showWaiting) return true;
        return pos.area === "stage" || pos.area == null;
      }),
    [performers, placements, showWaiting]
  );

  // 100%表示の基準（bounds）は、出演者の配置ではなく「舞台空間そのもの」の固定範囲から
  // 計算する。これにより、出演者が袖へ移動しても・待機エリアの人数が変わっても・
  // 構成間アニメーションが進行中でも、カメラの倍率（bounds.totalW/totalH）は一切変化しない。
  // PNG Export v1.2・18章：計算式自体はcomputeAudienceViewBounds()（module scopeのpure関数）へ
  // 切り出し、ここではuseMemoでラップして呼ぶだけにした（依存配列・結果は元の実装と完全に
  // 同一で、挙動は変更していない）。これによりPNG Exportの俯瞰レンダラーも同じ関数を通して
  // 常に同一の画角を得られる（19章：俯瞰PNG専用の別計算を作らない）。
  const bounds = useMemo(
    () => computeAudienceViewBounds(stage, zones, showWaiting),
    [stage, zones, showWaiting]
  );

  // 疑似遠近法の投影： 奥ほど「小さく／上に／中央へ圧縮／少し透ける」
  // ※ ここは表示ズーム（viewState.zoom）とは独立した「カメラの遠近効果」。
  //   表示ズームは外側の viewGroup transform（下記）で別レイヤーとして重ねている。
  // PNG Export v1.2・18章：計算式自体はprojectAudiencePoint()（module scopeのpure関数）へ
  // 切り出し済み。centerXcm/floorY/depthFactorはそちらの内部でのみ計算されるため、ここでは
  // 中間変数として保持しない（元の実装と数式・出力は完全に同一）。
  const project = useCallback(
    (xUnits, yUnits) => projectAudiencePoint(bounds, stage.depth, xUnits, yUnits),
    [bounds, stage.depth]
  );

  const stageFrontLeft = project(-halfW, 0);
  const stageFrontRight = project(halfW, 0);
  const stageBackLeft = project(-halfW, stage.depth);
  const stageBackRight = project(halfW, stage.depth);

  // UI Stability & Bottom Navigation v1・PART D/E：Audience Stage Guide
  // （grid・センターライン・センター十字・幅目盛り・奥行き目盛り）。
  // geometry自体（「どこに線・目盛りが存在するか」というステージ座標上の定義）は
  // buildAudienceStageGuideGeometry(stage)というpure関数に一本化してあり、俯瞰PNGの
  // renderAudienceFormationExport()もこの同じ関数を呼ぶ（PART E：Stage座標→
  // projectAudiencePoint()→俯瞰画面座標、という一本化された流れ）。ここでは、その
  // geometryの各点をproject()に通して画面座標へ変換するだけにする。
  const stageGuide = useMemo(() => buildAudienceStageGuideGeometry(stage), [stage]);

  // 座標目盛り（幅方向）：以前はここで直接ループしてtickの値を計算していたが（＝
  // computeWidthAxisTickValues()と同じ内容を二重実装していた）、PART Eの指示に従い
  // stageGuide.widthTicks（既存のcomputeWidthAxisTickValues()をそのまま使ったもの）を
  // project()で投影するだけに変更した。値・ラベルの意味（中央0・上手＋／下手−、
  // 番号自体は符号なしの絶対値表示）は変更していない。
  const audienceXTicks = useMemo(
    () =>
      stageGuide.widthTicks.map((t) => {
        const pos = project(t.x, t.y);
        return { key: `axt${t.value}`, sx: pos.sx, sy: pos.sy, label: String(Math.abs(t.value)), isCenter: t.value === 0 };
      }),
    [stageGuide, project]
  );

  // 奥行き目盛り：ステージ左右端（x=±halfW）に沿った奥行き位置。値・範囲は既存の
  // computeDepthAxisTickValues()（stageGuide.depthTicksが内部で使用）と同じ。
  const audienceDepthTicks = useMemo(
    () =>
      stageGuide.depthTicks.map((t) => ({
        key: `adt${t.value}`,
        left: project(t.xLeft, t.y),
        right: project(t.xRight, t.y),
        label: String(t.value),
      })),
    [stageGuide, project]
  );

  // grid（縦・横）：stageGuideのgridVertical/gridHorizontalの各線分の両端をproject()で
  // 投影するだけ。奥行きのある俯瞰投影のため、投影後は自然に台形状・遠近感のある線になる。
  const audienceGridVertical = useMemo(
    () => stageGuide.gridVertical.map((seg, i) => ({ key: `agv${i}`, a: project(seg.x1, seg.y1), b: project(seg.x2, seg.y2) })),
    [stageGuide, project]
  );
  const audienceGridHorizontal = useMemo(
    () => stageGuide.gridHorizontal.map((seg, i) => ({ key: `agh${i}`, a: project(seg.x1, seg.y1), b: project(seg.x2, seg.y2) })),
    [stageGuide, project]
  );
  const audienceCenterLine = useMemo(
    () => ({ a: project(stageGuide.centerLine.x1, stageGuide.centerLine.y1), b: project(stageGuide.centerLine.x2, stageGuide.centerLine.y2) }),
    [stageGuide, project]
  );
  const audienceCenterCross = useMemo(
    () => project(stageGuide.centerCross.x, stageGuide.centerCross.y),
    [stageGuide, project]
  );

  // 奥の人から先に描画（手前の人が上に重なる）。選択中は（複数でも）必ず最前面に描画する。
  const sorted = useMemo(() => {
    const arr = visiblePerformers
      .map((p) => ({ p, pos: placements[p.id] }))
      .filter((v) => !!v.pos)
      .sort((a, b) => b.pos.y - a.pos.y);
    const rest = [];
    const selected = [];
    arr.forEach((v) => (selectedIdSet.has(v.p.id) ? selected.push(v) : rest.push(v)));
    return [...rest, ...selected];
  }, [visiblePerformers, placements, selectedIdSet]);

  // ------------------------------------------------------------
  // 拡大縮小・画面移動（表示用の操作。出演者データ・遠近投影は一切変更しない）
  // ------------------------------------------------------------
  useImperativeHandle(ref, () => ({
    fitAll: () => onViewStateChange({ ...DEFAULT_VIEW_STATE }),
    fitStage: () => {
      const minX = Math.min(stageFrontLeft.sx, stageBackLeft.sx);
      const maxX = Math.max(stageFrontRight.sx, stageBackRight.sx);
      const minY = Math.min(stageFrontLeft.sy, stageFrontRight.sy, stageBackLeft.sy, stageBackRight.sy);
      const maxY = Math.max(stageFrontLeft.sy, stageFrontRight.sy, stageBackLeft.sy, stageBackRight.sy);
      onViewStateChange(computeFitViewState(minX, minY, maxX, maxY, bounds, 0.8));
    },
    fitSelected: () => {
      if (!selectedIds.length) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      selectedIds.forEach((id) => {
        const pos = placements[id];
        if (!pos) return;
        const { sx, sy } = project(pos.x, pos.y);
        minX = Math.min(minX, sx);
        maxX = Math.max(maxX, sx);
        minY = Math.min(minY, sy);
        maxY = Math.max(maxY, sy);
      });
      if (!isFinite(minX)) return;
      const r = 200;
      onViewStateChange(computeFitViewState(minX - r, minY - r, maxX + r, maxY + r, bounds, 0.9));
    },
  }));

  const dragState = useRef(null);
  const startPan = (e) => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.setPointerCapture(e.pointerId);
    dragState.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPanX: viewState.panX,
      startPanY: viewState.panY,
      moved: false,
    };
  };
  const handlePointerMove = (e) => {
    const st = dragState.current;
    if (!st || st.pointerId !== e.pointerId) return;
    const svg = svgRef.current;
    if (!svg) return;
    const ctm = svg.getScreenCTM();
    if (!ctm || !ctm.a) return;
    const dxClient = e.clientX - st.startClientX;
    const dyClient = e.clientY - st.startClientY;
    if (!st.moved && (Math.abs(dxClient) > 3 || Math.abs(dyClient) > 3)) st.moved = true;
    onViewStateChange({
      panX: st.startPanX + dxClient / ctm.a,
      panY: st.startPanY + dyClient / ctm.d,
    });
  };
  const handlePointerUp = (e) => {
    const st = dragState.current;
    if (!st || st.pointerId !== e.pointerId) return;
    if (!st.moved) onSelect(null); // 動かさずに離した＝背景クリック＝選択解除
    dragState.current = null;
  };

  const sizeComp = figureMinSizeCompensation(viewState.zoom);
  const groupTransform = viewGroupTransform(viewState, bounds);

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${bounds.totalW} ${bounds.totalH}`}
      width={width}
      height={height}
      style={{
        display: "block",
        margin: "0 auto",
        maxWidth: "100%",
        maxHeight: "100%",
        touchAction: "none",
        // 平面図と同じ方針：このビュー全体でブラウザ標準のテキスト選択を無効化する（9・10章）。
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
      onPointerDown={startPan}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <g ref={viewGroupRef} transform={groupTransform}>
        {/* 背景レイヤー（操作対象外）：ステージ床・縁の線・下手/上手ラベル。平面図と同じ方針で
            pointerEvents="none" + userSelect:noneにし、クリック／文字選択の対象にならないようにする
            （このビューは矩形選択には対応していないが、出演者クリック・背景pan・文字選択の
            干渉防止という原則は平面図と統一する＝10章）。 */}
        <g pointerEvents="none" style={{ userSelect: "none", WebkitUserSelect: "none" }}>
          {/* ステージ床（台形＝奥ほど狭い） */}
          <polygon
            points={`${stageFrontLeft.sx},${stageFrontLeft.sy} ${stageFrontRight.sx},${stageFrontRight.sy} ${stageBackRight.sx},${stageBackRight.sy} ${stageBackLeft.sx},${stageBackLeft.sy}`}
            fill={THEME.stageFloor}
            stroke={THEME.gridLine}
            strokeWidth={2}
          />

          <line x1={stageFrontLeft.sx} y1={stageFrontLeft.sy} x2={stageFrontLeft.sx} y2={stageFrontLeft.sy - 20} stroke={THEME.textDim} strokeWidth={1.5} />
          <line x1={stageFrontRight.sx} y1={stageFrontRight.sy} x2={stageFrontRight.sx} y2={stageFrontRight.sy - 20} stroke={THEME.textDim} strokeWidth={1.5} />
          <text x={stageFrontLeft.sx} y={stageFrontLeft.sy + 26} fill={THEME.textDim} fontSize={16} textAnchor="middle">下手</text>
          <text x={stageFrontRight.sx} y={stageFrontRight.sy + 26} fill={THEME.textDim} fontSize={16} textAnchor="middle">上手</text>
        </g>

        {/* UI Stability & Bottom Navigation v1・PART D・E-1・E-5：Stage Guideのgrid
            （縦・横）。stageGuide（buildAudienceStageGuideGeometryの結果）の各線分を
            project()で投影しただけの、出演者より控えめな線。描画順は「ステージ面の直後・
            目盛り／センターより前」＝E-5の優先順位どおり。 */}
        <g pointerEvents="none" style={{ userSelect: "none", WebkitUserSelect: "none" }}>
          {audienceGridVertical.map((seg) => (
            <line key={seg.key} x1={seg.a.sx} y1={seg.a.sy} x2={seg.b.sx} y2={seg.b.sy} stroke={THEME.gridLineHalf} strokeOpacity={0.7} strokeWidth={0.8} />
          ))}
          {audienceGridHorizontal.map((seg) => (
            <line key={seg.key} x1={seg.a.sx} y1={seg.a.sy} x2={seg.b.sx} y2={seg.b.sy} stroke={THEME.gridLineHalf} strokeOpacity={0.7} strokeWidth={0.8} />
          ))}
        </g>

        {/* 座標目盛り：ステージ前端の横位置（中央0、上手＋／下手−）。小さめ・控えめな表示にし、
            出演者やステージ本体の邪魔にならないよう、人物より背面（このブロックより後で描画）かつ
            pointerEvents="none"にして操作（ドラッグ・パン・クリック）を一切妨げないようにする。
            userSelect:noneも重ねて指定し、目盛り数字がブラウザの文字選択対象にならないようにする。 */}
        <g pointerEvents="none" style={{ userSelect: "none", WebkitUserSelect: "none" }}>
          {audienceXTicks.map((t) => (
            <g key={t.key}>
              <line
                x1={t.sx}
                y1={t.sy}
                x2={t.sx}
                y2={t.sy + 5}
                stroke={t.isCenter ? THEME.accent : THEME.textDim}
                strokeOpacity={t.isCenter ? 0.8 : 0.6}
                strokeWidth={t.isCenter ? 1.2 : 0.8}
              />
              <text
                x={t.sx}
                y={t.sy + 15}
                fill={t.isCenter ? THEME.accent : THEME.textDim}
                fillOpacity={t.isCenter ? 0.9 : 0.65}
                fontSize={9}
                fontWeight={t.isCenter ? "bold" : "normal"}
                textAnchor="middle"
              >
                {t.label}
              </text>
            </g>
          ))}
        </g>

        {/* UI Stability & Bottom Navigation v1・PART D・E-4：奥行き目盛り（左右端＝x=±halfW、
            0=舞台前端）。値・範囲はcomputeDepthAxisTickValues()（stageGuide.depthTicks）と
            同じ。平面図PNGと同様、左右両端に表示する。 */}
        <g pointerEvents="none" style={{ userSelect: "none", WebkitUserSelect: "none" }}>
          {audienceDepthTicks.map((t) => (
            <g key={t.key}>
              <line x1={t.left.sx - 5} y1={t.left.sy} x2={t.left.sx} y2={t.left.sy} stroke={THEME.textDim} strokeOpacity={0.6} strokeWidth={0.8} />
              <text x={t.left.sx - 9} y={t.left.sy} fill={THEME.textDim} fillOpacity={0.65} fontSize={9} textAnchor="end" dominantBaseline="middle">
                {t.label}
              </text>
              <line x1={t.right.sx} y1={t.right.sy} x2={t.right.sx + 5} y2={t.right.sy} stroke={THEME.textDim} strokeOpacity={0.6} strokeWidth={0.8} />
              <text x={t.right.sx + 9} y={t.right.sy} fill={THEME.textDim} fillOpacity={0.65} fontSize={9} textAnchor="start" dominantBaseline="middle">
                {t.label}
              </text>
            </g>
          ))}
        </g>

        {/* UI Stability & Bottom Navigation v1・PART D・E-2：センターライン（x=0）・
            センター十字（x=0, y=stage.depth/2）。平面図と全く同じstage coordinateを
            project()で投影しただけ（PART G：stage coordinateとして一致）。 */}
        <g pointerEvents="none" style={{ userSelect: "none", WebkitUserSelect: "none" }}>
          <line
            x1={audienceCenterLine.a.sx}
            y1={audienceCenterLine.a.sy}
            x2={audienceCenterLine.b.sx}
            y2={audienceCenterLine.b.sy}
            stroke={THEME.textDim}
            strokeOpacity={0.5}
            strokeWidth={1}
          />
          <line
            x1={audienceCenterCross.sx - 9}
            y1={audienceCenterCross.sy}
            x2={audienceCenterCross.sx + 9}
            y2={audienceCenterCross.sy}
            stroke={THEME.accent}
            strokeOpacity={0.8}
            strokeWidth={1.6}
          />
          <line
            x1={audienceCenterCross.sx}
            y1={audienceCenterCross.sy - 9}
            x2={audienceCenterCross.sx}
            y2={audienceCenterCross.sy + 9}
            stroke={THEME.accent}
            strokeOpacity={0.8}
            strokeWidth={1.6}
          />
        </g>

        {/* 移動軌跡（表示専用レイヤー）：人物本体より背面・非インタラクティブに描画する。
            平面図と同じ transitionPaths（App側でcomputeTransitionPathsにより毎回計算し直された
            「開始→終了」の経路・表示専用情報）を、このビュー独自の疑似遠近法project()で
            投影するだけで済ませる。
            tp.type === "curve" の場合、開始点・waypoint・終点の3点をそれぞれproject()で
            投影し、その投影後の3点をそのまま二次ベジェのSVGパスとして描画する（project()は
            奥行きによって縮尺が変わる非線形の疑似遠近法のため、舞台座標上の曲線を厳密に
            投影したものとは僅かに異なるが、無理に高度な変換は行わず、平面図と同じ考え方の
            単純な近似描画に留める＝v1の「無理に複雑な表現へ変更しない」方針を踏襲）。
            このビューではwaypointのドラッグ編集は行わない（v1では平面図のみ対応）。
            選択中の出演者の軌跡だけ太く・濃く強調する。 */}
        {transitionPaths && transitionPaths.length > 0 && (
          <g pointerEvents="none">
            {transitionPaths.map((tp) => {
              const performer = performers.find((p) => p.id === tp.id);
              const color = (performer && performer.color) || THEME.textDim;
              const emphasized = selectedIdSet.has(tp.id);
              const fromProj = project(tp.from.x, tp.from.y);
              const toProj = project(tp.to.x, tp.to.y);
              const arrowSize = emphasized ? 12 : 8;
              const isCurve = tp.type === "curve" && tp.waypoint;
              const wpProj = isCurve ? project(tp.waypoint.x, tp.waypoint.y) : null;
              const arrowPts = isCurve
                ? trajectoryArrowPoints(wpProj.sx, wpProj.sy, toProj.sx, toProj.sy, arrowSize)
                : trajectoryArrowPoints(fromProj.sx, fromProj.sy, toProj.sx, toProj.sy, arrowSize);
              return (
                <g key={`traj-${tp.id}`} opacity={emphasized ? 0.9 : 0.35}>
                  <circle cx={fromProj.sx} cy={fromProj.sy} r={emphasized ? 4 : 2.5} fill={color} />
                  {isCurve ? (
                    <path
                      d={`M ${fromProj.sx} ${fromProj.sy} Q ${wpProj.sx} ${wpProj.sy} ${toProj.sx} ${toProj.sy}`}
                      fill="none"
                      stroke={color}
                      strokeWidth={emphasized ? 3 : 1.5}
                      strokeLinecap="round"
                    />
                  ) : (
                    <line
                      x1={fromProj.sx}
                      y1={fromProj.sy}
                      x2={toProj.sx}
                      y2={toProj.sy}
                      stroke={color}
                      strokeWidth={emphasized ? 3 : 1.5}
                      strokeLinecap="round"
                    />
                  )}
                  {arrowPts && <polygon points={arrowPts} fill={color} />}
                </g>
              );
            })}
          </g>
        )}

        {/* 人物本体（奥から手前の順に描画） */}
        {sorted.map(({ p, pos }) => {
          const { sx, sy, scale, opacity } = project(pos.x, pos.y);
          // 出演者表示サイズ v1.1・PART E：俯瞰客席ビューは「身長 小・中・大」だけで人物サイズ・
          // 身長差を表現する設計のため、performerDisplayScale（平面図専用の表示設定）は
          // ここでは一切参照しない（v1で誤って反映していた掛け算を撤去した）。
          const heightPx = p.height * scale * sizeComp;
          // 身長 v2・PART E〜G：X方向（体格）の基準はDEFAULT_PERFORMER_HEIGHT固定で計算し、
          // 実際のp.heightによる横幅の変化を防ぐ（頭・肩幅・胴体幅・脚の太さ等はrefHeightPx側で
          // 決まり、heightPxは縦方向の位置・長さにだけ使われる＝FrontFigure/FrontFigureKneeling内部）。
          const refHeightPx = DEFAULT_PERFORMER_HEIGHT * scale * sizeComp;
          const warn = isBeyondAllAreas(pos, zones) || overlapIds.has(p.id);
          const pose = getPlacementPose(pos);
          return (
            <g
              key={p.id}
              transform={`translate(${sx} ${sy})`}
              opacity={opacity}
              style={{ cursor: locked ? "default" : "pointer" }}
              onPointerDown={(e) => {
                e.stopPropagation();
                if (locked) return; // 再生中は選択操作を無効化（誤操作防止）。zoom/panは背景側の操作なので影響しない
                if (e.shiftKey) {
                  // Shift＋クリック：選択への追加・解除（このビューでは矩形選択は未対応）
                  onToggleSelect(p.id);
                  return;
                }
                onSelect(p.id);
              }}
            >
              <FrontFigure color={p.color} selected={selectedIdSet.has(p.id)} warn={warn} heightPx={heightPx} pose={pose} refHeightPx={refHeightPx} />
            </g>
          );
        })}

        {/* 胸の番号は常に最前面にまとめて描画し、重なっても読めるようにする。
            丸バッジ（背景の円）は使わず、数字のみを表示する。選択中はアクセント色にして
            既存の「選択中がわかる」仕様を維持しつつ、濃色の縁取り（paintOrder="stroke"）で
            どんな背景の上でも読みやすくする。
            フォントサイズ・タグ位置は姿勢ごとにfrontFigureChestMetrics()（FrontFigure／
            FrontFigureKneelingの胴体比率と同期）で算出するため、身長プリセットの違いや
            奥行き方向の遠近スケール・zoomアウト時の最小サイズ補正（sizeComp）・姿勢の違いにも
            自動で追従し、数字がchestWidthを超えないようクランプされた範囲で1桁・2桁とも
            胴体内に収まるサイズにする。chestWidth自体はrefHeightPx基準（身長プリセットで
            横幅が変わらない＝PART E）なので、番号の大きさも小・中・大でほぼ同じになる。 */}
        {sorted.map(({ p, pos }) => {
          const { sx, sy, scale } = project(pos.x, pos.y);
          const heightPx = p.height * scale * sizeComp;
          const refHeightPx = DEFAULT_PERFORMER_HEIGHT * scale * sizeComp;
          const pose = getPlacementPose(pos);
          const { tagOffsetY, chestWidth } = frontFigureChestMetrics(heightPx, pose, refHeightPx);
          const tagY = sy + tagOffsetY;
          const fontSize = performerNumberFontSizeAudience(chestWidth, p.number);
          const isSelected = selectedIdSet.has(p.id);
          return (
            <text
              key={`tag-${p.id}`}
              x={sx}
              y={tagY}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={fontSize}
              fontWeight="bold"
              fill={isSelected ? THEME.accent : "#ffffff"}
              stroke="rgba(0,0,0,0.7)"
              strokeWidth={Math.max(1.5, fontSize * 0.1)}
              paintOrder="stroke"
              // この番号タグは装飾用オーバーレイであり、実際のクリック判定は下に描画されている
              // FrontFigureの<g onPointerDown>が受け持つ。pointerEvents="none"にしてこのテキスト自身が
              // イベントターゲットにならないようにすることで、番号の上をクリックしても常に
              // 出演者本体をクリックしたのと同じ扱いになる（3章：TopViewの出演者番号と同じ原則）。
              // 併せてuserSelect:noneでブラウザの文字選択対象からも外す。
              pointerEvents="none"
              style={{ userSelect: "none", WebkitUserSelect: "none" }}
            >
              {p.number}
            </text>
          );
        })}
      </g>
    </svg>
  );
});

// 構成間アニメーション（単体再生・連続再生）のidle時の共通の形。App内の複数箇所（初期値・
// forceIdle・手動構成切替時のリセットなど）で全く同じ形を使うため、ここに1箇所だけ定義しておく
// （spreadせずそのまま使う。Reactのstateは常に新しいオブジェクトをsetする前提のみで安全なため、
// 同じオブジェクト参照を複数回setState()に渡しても問題ない＝内部で書き換えることはない）。
const IDLE_ANIMATION_STATE = {
  playbackState: "idle", // "idle" | "playing" | "paused"
  playbackMode: "single", // "single" | "continuous"
  phase: "move", // "move" | "keep"
  fromIndex: null,
  toIndex: null,
  progress: 0,
};

// Music Timing v1.5・9〜10・14章：プリロール（イントロ）中の構成アニメーションの「見た目上の状態」。
// 実際にはまだ何も動いていない（keep/moveのrAFは開始していない）が、既存のisTransitionActive /
// isAnimationRunningによる編集ロック・▶/▶▶ボタンの無効化・スクラバーロックをそのまま再利用する
// ため、playbackStateだけ"playing"扱いにしておく。phase:"preroll"はexisting runPhase系関数が
// 使う"move"/"keep"のどちらでもない新しい値のため、displayPlacements等の既存の分岐
// （phase==="keep"以外は toIndex==null なら現在のplacementsをそのまま返す）に自然に乗って、
// 「プリロール中は現在構成を静止表示する」（14章）が既存コードの変更無しに成立する。
// fromIndex/toIndexをnullのままにしているのもそのため。
const PREROLL_ANIMATION_STATE = {
  playbackState: "playing",
  playbackMode: "continuous",
  phase: "preroll",
  fromIndex: null,
  toIndex: null,
  progress: 0,
};

// Music Sync Playback v1 → Music Timing v1.5：同期セッションが非アクティブな状態の共通の形。
// IDLE_ANIMATION_STATEと同じ考え方で、複数箇所での再定義・フィールドの書き漏らしを防ぐために
// 1箇所だけ定義しておく。
const IDLE_SYNC_PLAYBACK = { isActive: false, isPaused: false, phase: "active", animationStartSec: null };

// キープ進捗・移動進捗（連続再生のステータスラベル、スクラバーのカウント表示）で共通して使う、
// 「現在何カウント目か」を表示する数字部分専用のコンポーネント。
// 0.5カウント刻みで値が変わるたびに表示桁数（1 → 1.5 → 2 → 2.5 …、あるいは2桁+.5）が変化しても、
// 固定幅・右寄せ・tabular-numsにしておくことで、周囲のテキストやUIの位置がずれないようにする
// （キープ表示・移動表示・スクラバー表示のすべてでこの1つのコンポーネントを再利用し、
// 同じ見た目のロジックを重複実装しない）。
function FixedCountValue({ value }) {
  return (
    <span
      style={{
        display: "inline-block",
        minWidth: "4.5ch", // 例："16.5"（4文字）程度までは幅が変わらないよう少し余裕を持たせる
        textAlign: "right",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {value}
    </span>
  );
}

// ------------------------------------------------------------------
// メインアプリ
// ------------------------------------------------------------------
export default function App() {
  // ==============================================================
  // Multi Project / Workspace v1
  // ==============================================================
  // Workspace（projects[] + activeProjectId）をアプリ全体のSingle Source of Truthとする。
  // 初回マウント時にlocalStorageから1回だけ読み込む（以後はsetWorkspaceで更新し、
  // localStorageへは変更のたびに書き戻す＝下記autosave useEffect）。
  const workspaceInitRef = useRef(null);
  if (workspaceInitRef.current === null) {
    workspaceInitRef.current = loadWorkspace();
  }
  const [workspace, setWorkspace] = useState(workspaceInitRef.current);

  // 現在アクティブなProject。activeProjectIdに対応するものが万一見つからない場合でも
  // （理論上loadWorkspace/normalizeWorkspaceが保証するため起きないはずだが、念のため）
  // 先頭のProjectへ安全にフォールバックする。
  const activeProject = useMemo(
    () => workspace.projects.find((p) => p.id === workspace.activeProjectId) || workspace.projects[0],
    [workspace]
  );

  // 出演者操作の「作品データ」（Undo/Redo対象）。stage / performers / slides / currentSlideIndex を
  // ひとまとめにして履歴管理する。将来 lights や timeline を追加する場合もこのオブジェクトに
  // キーを足すだけでよい。初期値はactive Projectのworkであり、最初の1回だけ生成すればよいので
  // useRef で固定する（以後の値はuseHistoryStateの内部stateが唯一の管理元＝Project切替時のみ
  // reset()で明示的に入れ替える。29章：Workspace.projects[x].workとは別のwork stateを
  // 二重管理しない、という要件は、後述のsync用useEffectで一方向に同期することで満たす）。
  const initialWorkRef = useRef(null);
  if (initialWorkRef.current === null) {
    initialWorkRef.current = activeProject.work;
  }
  const {
    present: work,
    commit: commitWork,
    updateLive: updateWorkLive,
    beginBatch: beginWorkBatch,
    endBatch: endWorkBatch,
    undo: undoWork,
    redo: redoWork,
    reset: resetWork,
    canUndo,
    canRedo,
  } = useHistoryState(initialWorkRef.current, HISTORY_LIMIT);
  // 注意：work.transitionPaths（曲線移動の経路データ・作品データ）と、下記で定義する
  // 表示専用のローカル変数 transitionPaths（軌跡表示用に毎回計算し直す配列）は
  // 名前が紛らわしいため、work側は destructure 時に transitionPathConfig という
  // 別名で受け取る（work.transitionPaths というプロパティ名自体は変更しない）。
  const { stage, performers, slides, currentSlideIndex, transitionCounts, transitionPaths: transitionPathConfig } = work;

  // このプロジェクトの実際のBPM。work.projectが無い（BPM機能実装前の古いデータ）場合や
  // project.bpmが数値でない場合はDEFAULT_BPMへfallbackする（getProjectBpm参照）。
  // 再生計算（countsToDurationMs）には、以降このprojectBpmだけを渡し、DEFAULT_BPMを
  // 直接渡さない。
  const projectBpm = getProjectBpm(work);

  // 出演者表示サイズ v1・PART A：Project全体で1つの表示設定（work.project.performerDisplayScale）。
  // 未設定・不正値は「大＝1.0」へフォールバックする（getPerformerDisplayScale参照）。
  const performerDisplayScale = getPerformerDisplayScale(work);
  const performerNameScale = getPerformerNameScale(performerDisplayScale);

  // Music Section一覧（work.project.musicSections）。古いデータ・未設定の場合も
  // getMusicSections()が必ず最低1件を返すため、以降のUIはこの配列だけを見ればよい（15章）。
  const musicSections = getMusicSections(work);

  // 選択状態はUI専用のstate（performers / slides には保存しない＝履歴の対象外）。
  // 複数選択に対応するため配列で保持し、単独選択・従来動作は selectedPerformer 等の
  // 派生値（selectedIds.length === 1 のときだけ有効）で表現する。
  const [selectedIds, setSelectedIds] = useState([]);
  const [viewMode, setViewMode] = useState("top");

  const selectOnly = useCallback((id) => {
    setSelectedIds(id ? [id] : []);
  }, []);
  const toggleSelect = useCallback((id) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);
  const handleRectSelect = useCallback((ids) => {
    setSelectedIds(ids);
  }, []);

  // Undo/Redo後（および出演者削除後）に、存在しない出演者IDが selectedIds に
  // 残らないよう自動的に整理する。
  useEffect(() => {
    setSelectedIds((prev) => {
      const existingIds = new Set(performers.map((p) => p.id));
      const filtered = prev.filter((id) => existingIds.has(id));
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [performers]);

  // 待機エリア（下手袖・上手袖・舞台奥）の表示切替
  const [showBackstage, setShowBackstage] = useState(true);
  // 俯瞰客席ビューで待機中の出演者も表示するかどうか
  const [showWaitingInOverhead, setShowWaitingInOverhead] = useState(false);
  // 「？ 操作方法」パネルの開閉状態。表示のON/OFFだけの一時的なUI stateであり、
  // 作品データ（work）には含めないため履歴（Undo/Redo）の対象外。初期状態は閉じておく。
  const [helpOpen, setHelpOpen] = useState(false);
  // 右編集パネルの整理 v1（PART D・新規）：「全体の設定」「構成ごとの設定」2グループの開閉状態。
  // 折りたたみ状態は作品データではなく表示のON/OFFだけの一時的なUI stateのため、
  // work（Undo/Redo対象）には含めない（21章）。PC・タブレットでの初期状態はどちらも開いた状態（20章）。
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(true);
  const [slideSettingsOpen, setSlideSettingsOpen] = useState(true);
  // 各設定パネル内の「説明を見る」開閉状態（PART E・新規）。こちらも作品データではないため
  // Undo/Redo対象外（26章）。パネルが増えてもuseStateを増やさずに済むよう、キー付きの
  // 1つのオブジェクトstateへまとめてある（例：keepCounts, musicAnchor, musicSection）。
  const [descOpen, setDescOpen] = useState({});
  const toggleDesc = useCallback((key) => {
    setDescOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);
  // 右サイドバー（編集パネル）の表示／非表示。PC・タブレット横向き（800px以上）でのみ
  // 意味を持つ一時的なUI state。work / slides / viewState / selectedIds には保存せず、
  // 履歴（Undo/Redo）の対象にもしない。初期値は表示（true）。
  // 800px未満では、この値に関係なくCSS側で常にサイドバーを表示する（狭い画面の編集操作を守るため）。
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const toggleSidebar = useCallback(() => setSidebarOpen((o) => !o), []);
  // 操作方法パネルはサイドバー内に表示するため、サイドバーを閉じた状態で開こうとした場合は
  // サイドバーも一緒に再表示する（簡易対応）。
  const toggleHelp = useCallback(() => {
    setHelpOpen((prevOpen) => {
      const nextOpen = !prevOpen;
      if (nextOpen) setSidebarOpen(true);
      return nextOpen;
    });
  }, []);

  // ステージ設定から各エリアの範囲を算出（stage.width / stage.depth が変わるたびに再計算）
  const zones = useMemo(() => computeZones(stage), [stage]);

  // 待機エリア間スマート経路v1：work.transitionPaths（手動設定。source/isAutoが無い
  // 既存データも含め常に最優先＝11章・13章）に、まだ経路データが無いperformer×遷移だけ
  // スマート経路の初期提案を「表示専用」で補完した実効設定。work（作品データ）へは
  // 一切書き込まないため、area変更・構成追加のたびにここで自動的に再計算されるだけで、
  // Undo/Redo履歴を一切増やさない（24章の「1操作＝1履歴」を、そもそも追加の書き込みを
  // 行わないことで構造的に満たす）。以降、曲線移動の表示・アニメーション・軌跡・
  // waypoint編集ハンドルは、すべてこの実効設定（transitionPathConfigそのものではなく
  // effectiveTransitionPathConfig）を参照する。
  const effectiveTransitionPathConfig = useMemo(
    () => computeEffectiveTransitionPathConfig(slides, transitionPathConfig, stage, zones),
    [slides, transitionPathConfig, stage, zones]
  );

  // ------------------------------------------------------------
  // 表示状態（ズーム倍率・表示位置）
  // 出演者の座標やステージ設定とは完全に分離した state。履歴（Undo/Redo）の対象外。
  // 平面図（topView）と俯瞰客席ビュー（audienceView）でそれぞれ独立して持つ。
  // 将来スライドごとに保存したい場合は、この state を Slide オブジェクトの
  // 中に移すだけで対応できる形にしてある（アプリ全体で1つ／スライドごとに1つ、
  // どちらにも寄せやすいよう更新ロジックを1関数にまとめている）。
  // ------------------------------------------------------------
  const [viewState, setViewState] = useState({
    topView: { ...DEFAULT_VIEW_STATE },
    audienceView: { ...DEFAULT_VIEW_STATE },
  });
  const viewStateKey = viewMode === "top" ? "topView" : "audienceView";
  const activeViewState = viewState[viewStateKey];

  const updateViewState = useCallback((key, patch) => {
    setViewState((prev) => ({
      ...prev,
      [key]: {
        ...prev[key],
        ...(typeof patch === "function" ? patch(prev[key]) : patch),
      },
    }));
  }, []);

  const handleViewStateChange = useCallback((patch) => updateViewState(viewStateKey, patch), [updateViewState, viewStateKey]);

  const zoomBy = useCallback(
    (delta) => {
      updateViewState(viewStateKey, (prev) => ({ zoom: roundZoom(prev.zoom + delta) }));
    },
    [updateViewState, viewStateKey]
  );
  const resetZoomTo100 = useCallback(() => updateViewState(viewStateKey, { zoom: 1 }), [updateViewState, viewStateKey]);

  // 表示専用の操作（拡大縮小・全体表示・ステージに合わせる・選択中へフォーカス）を
  // 現在アクティブなビュー（TopView / OverheadAudienceView）に委譲するための ref。
  const activeViewRef = useRef(null);

  const containerRef = useRef(null);
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 });

  // トラックパッドのピンチ操作（Mac系ブラウザは ctrlKey 付きの wheel イベントとして届く）にも
  // 簡易対応する。環境によって挙動が安定しない場合があるため、あくまで補助的な機能。
  const handleWheelZoom = useCallback(
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const delta = -e.deltaY * 0.01;
      updateViewState(viewStateKey, (prev) => ({ zoom: roundZoom(prev.zoom + delta) }));
    },
    [updateViewState, viewStateKey]
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setContainerSize({ width, height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ==============================================================
  // 音楽（Music基盤 v2：Web Audio API方式）
  // ==============================================================
  // v1（HTMLAudioElement + <audio src="blob:...">）はArtifact環境で
  // MEDIA_ERR_SRC_NOT_SUPPORTED（blob:の再生そのものが弾かれる）となり、data:URL
  // フォールバックでも改善しなかったため、今回から音声パイプラインを
  //   File → ArrayBuffer → AudioContext.decodeAudioData() → AudioBuffer
  //   → AudioBufferSourceNode → audioContext.destination
  // というWeb Audio API方式に全面的に置き換える。<audio>要素・audioRef・
  // audio.play/pause/currentTime/duration・loadedmetadata/timeupdateはもう使わない。
  // blob:/data:URLもMusic機能からは完全に削除した（isBlobUrl/mediaErrorCodeLabelは
  // v1専用だったため、この置き換えに伴い未使用となり削除している）。
  //
  // 重要：File / AudioContext / AudioBuffer / AudioBufferSourceNode はいずれも
  // 「ブラウザ実行中だけ有効な非シリアライズオブジェクト」であるため、work（Undo/Redo対象の
  // 作品データ）・slides・履歴には一切保存しない。ここで宣言する state / ref はすべて work の
  // 外側にあるUI専用のruntime stateであり、useHistoryState（commitWork/updateWorkLive）を
  // 一切経由しない（＝再生・一時停止・シーク・ファイル選択のどれもUndo/Redo履歴を増やさない＝19章）。
  //
  // musicMeta は「将来 project.music（fileName / title / durationSec / bpmSource /
  // startOffsetSec など）へそのまま移行しやすい形」を意識した最小限のmetadataだけを持つ
  // オブジェクトだが、今回もwork.projectの中には保存しない（3章：構造だけ意識し、
  // 実際の保存先はまだ作らない）。
  //   fileName      : 表示用のファイル名
  //   durationSec   : audioBuffer.duration（Number）。decode未完了時はnull
  //   bpmSource     : 常に "manual"（今回はBPM自動推定を実装しないため。33章）
  //   startOffsetSec: 常に0（将来「曲頭とカウント開始のズレ」を持たせる場所）
  //
  // musicStatus（28章の診断ステータス）は音楽再生の状態機械を1つの文字列に集約したもの。
  //   "idle"     : ファイル未選択
  //   "reading"  : File → ArrayBuffer 取得中
  //   "decoding" : decodeAudioData() 実行中
  //   "ready"    : decode成功・再生可能（まだ再生していない、または曲末まで到達した後）
  //   "playing"  : 再生中
  //   "paused"   : 一時停止中（reading/decoding以外で「止まっている」状態はready/pausedで表現する）
  //   "error"    : いずれかの段階で失敗
  // musicIsPlayingという別のbooleanは持たず、musicStatus === "playing" を唯一の判定基準にする
  // （Single Source of Truthを1つに保つため）。
  //
  // 注意：file.type による事前フィルタは一切行っていない（27章：環境によってはFile.typeが
  // 空文字や想定外の値になりうるため、実際の再生可否は常にdecodeAudioData()自身に判定させる。
  // accept="audio/*"はファイル選択ダイアログの絞り込みに使うだけで、選択済みFileの受理・拒否には使わない）。
  const [musicMeta, setMusicMeta] = useState({
    fileName: "",
    durationSec: null,
    bpmSource: "manual",
    startOffsetSec: 0,
  });
  const [musicStatus, setMusicStatus] = useState("idle");
  const [musicError, setMusicError] = useState(null);
  const [musicCurrentTime, setMusicCurrentTime] = useState(0);
  // 診断チェックリスト（28・29章）。File選択〜SourceNode.start()までの各段階を個別に記録し、
  // 「decodeまでは成功したが実際の音声出力だけが失敗した」ようなケースを切り分けられるようにする。
  // UIには常時表示せず、MusicBar側の「詳細」トグルでのみ見せる。
  const [musicDiagnostics, setMusicDiagnostics] = useState(null);

  // ---- Web Audio API関連のruntime ref（すべてwork外・Undo/Redo対象外） ----
  const audioContextRef = useRef(null); // 1つだけ生成し、以後は再利用する（4章）
  const audioBufferRef = useRef(null); // decode済みAudioBuffer（work等へは保存しない＝5章）
  const sourceNodeRef = useRef(null); // 現在再生中のAudioBufferSourceNode（無ければnull）
  const musicOffsetSecRef = useRef(0); // 次にsource.start(0, offset)する際のoffset（13章）
  const musicStartedAtContextTimeRef = useRef(0); // audioContext.currentTime上での再生開始時刻
  const musicRafRef = useRef(null); // 音楽の現在位置表示専用rAF（構成アニメーションのanimationRefとは完全に別＝19章）
  const musicFileRef = useRef(null); // 現在読み込み中のFile本体（work等へは保存しない）

  // Project別音源管理v1：非同期音源処理（ファイル選択 / Project切替時のIndexedDB復元 /
  // ページ再読み込み時の復元）が競合した場合の安全策（12章）。
  // 「読み込みを開始した時点の世代」と「完了した時点の最新世代」が一致する場合だけ、
  // その結果をruntime（audioBufferRef・musicStatus等）へ反映する。
  // 例：Project Aの音源loadが進行中にすぐProject Bへ切り替えると、Bへの切替時点で世代が
  // 1つ進むため、遅れて完了したAのdecode結果は「古い世代」として判定され、Bの表示中に
  // Aの音源が紛れ込むことを防げる。
  const musicLoadGenerationRef = useRef(0);
  const beginNewMusicLoadGeneration = useCallback(() => {
    musicLoadGenerationRef.current += 1;
    return musicLoadGenerationRef.current;
  }, []);


  // AudioContextの生成・再利用（4章）。React再レンダーごとに新規生成せず、
  // 一度作ったインスタンスをrefに保持して使い回す。生成タイミングは「必要になった最初の瞬間」
  // （ファイル選択時のdecode、または▶再生時）に遅延させ、mount用useEffect内では生成しない
  // ＝React Strict Modeの開発時二重実行（mount→cleanup→mount）の影響を受けない（37章）。
  const getAudioContext = useCallback(() => {
    if (audioContextRef.current) return audioContextRef.current;
    const Ctx = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
    if (!Ctx) return null;
    const ctx = new Ctx();
    audioContextRef.current = ctx;
    return ctx;
  }, []);

  // 音楽専用rAFループの停止（19章）。構成アニメーション側のcancelAnimationLoopとは無関係の
  // 別関数・別refであることを明示するため、あえて似た名前を避けている。
  const cancelMusicRaf = useCallback(() => {
    if (musicRafRef.current != null) {
      cancelAnimationFrame(musicRafRef.current);
      musicRafRef.current = null;
    }
  }, []);

  // 現在のSourceNodeを安全に停止する（16章）。既に停止済み・start前などで例外になる
  // 可能性があるためtry/catchで握りつぶす。
  // 重要：停止前に source.onended を明示的に外している。これにより「手動でstopした」場合は
  // onended（＝自然終了ハンドラ）が一切呼ばれなくなり、17章が求める「自然終了」と
  // 「意図的なstop」の区別を、共有フラグに頼らずリスナーの有無だけで確実に行える
  // （フラグ方式より、停止直後に別のSourceNodeを連続生成してもレースが起きない点で安全）。
  const stopSourceNode = useCallback(() => {
    const source = sourceNodeRef.current;
    if (!source) return;
    source.onended = null;
    try {
      source.stop();
    } catch (err) {
      // 既に停止済み・start前などの例外は無害なため無視する
    }
    try {
      source.disconnect();
    } catch (err) {
      // noop
    }
    sourceNodeRef.current = null;
  }, []);

  // 音楽の現在位置表示専用rAFループ（18章）。musicOffsetSecRef（再生開始位置）と
  // musicStartedAtContextTimeRef（audioContext.currentTime基準の開始時刻）から、
  // 「現在位置 = offset + (audioContext.currentTime - startedAtContextTime)」を毎フレーム計算し、
  // durationを超えないようclampしてUI表示用stateへ反映する（13章の計算式そのまま）。
  const startMusicRaf = useCallback(() => {
    cancelMusicRaf();
    const step = () => {
      const ctx = audioContextRef.current;
      const buffer = audioBufferRef.current;
      if (!ctx || !buffer) {
        musicRafRef.current = null;
        return;
      }
      const elapsed = ctx.currentTime - musicStartedAtContextTimeRef.current;
      const pos = clamp(musicOffsetSecRef.current + elapsed, 0, buffer.duration);
      setMusicCurrentTime(pos);
      musicRafRef.current = requestAnimationFrame(step);
    };
    musicRafRef.current = requestAnimationFrame(step);
  }, [cancelMusicRaf]);

  // 自然終了（曲末まで再生し終えた場合）専用のハンドラ。stopSourceNode()経由の手動停止では
  // 事前にonendedを外しているため、ここに来るのは「本当に曲の最後まで再生された」場合のみ
  // （17章の区別）。musicIsPlaying=false・musicOffsetSec=durationSecとする（10章の「曲末で安全に停止」）。
  const handleSourceEnded = useCallback(() => {
    cancelMusicRaf();
    sourceNodeRef.current = null;
    const buffer = audioBufferRef.current;
    const duration = buffer ? buffer.duration : 0;
    musicOffsetSecRef.current = duration;
    setMusicCurrentTime(duration);
    setMusicStatus("paused");
  }, [cancelMusicRaf]);

  // 指定したoffsetSecから新しいAudioBufferSourceNodeを生成して再生を開始する（9・10・14章）。
  // AudioBufferSourceNodeは仕様上1回しかstart()できないため、既存のSourceNodeがあれば
  // 必ずstopSourceNode()で破棄してから新規に作り直す（既存を使い回さない）。
  // ▶クリック・再生中シークの両方からこの関数を呼ぶ（共通化）。
  const startPlaybackFrom = useCallback(
    async (offsetSec) => {
      const ctx = getAudioContext();
      const buffer = audioBufferRef.current;
      if (!ctx || !buffer) return false;

      // ブラウザのautoplay制限対策（4・11章）：▶やシークという明確なユーザー操作の中で
      // suspended状態のAudioContextをresumeする。
      if (ctx.state === "suspended") {
        try {
          await ctx.resume();
        } catch (err) {
          console.error("[Music] audioContext.resume() failed", err);
        }
      }
      setMusicDiagnostics((prev) => (prev ? { ...prev, contextState: ctx.state } : prev));
      if (ctx.state !== "running") {
        console.warn("[Music] AudioContext is not running after resume()", { state: ctx.state });
      }

      stopSourceNode();

      const clampedOffset = clamp(offsetSec, 0, buffer.duration);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = handleSourceEnded;

      try {
        source.start(0, clampedOffset);
      } catch (err) {
        console.error("[Music] source.start() failed", { err, offset: clampedOffset });
        setMusicStatus("error");
        setMusicError("音楽の再生を開始できませんでした。");
        setMusicDiagnostics((prev) => (prev ? { ...prev, lastError: { stage: "start", message: String((err && err.message) || err) } } : prev));
        return false;
      }

      sourceNodeRef.current = source;
      musicOffsetSecRef.current = clampedOffset;
      musicStartedAtContextTimeRef.current = ctx.currentTime;
      setMusicCurrentTime(clampedOffset);
      setMusicStatus("playing");
      setMusicError(null);
      setMusicDiagnostics((prev) =>
        prev ? { ...prev, sourceStarted: { offset: clampedOffset, atContextTime: ctx.currentTime } } : prev
      );
      console.info("[Music] source started", { offset: clampedOffset, contextState: ctx.state, contextTime: ctx.currentTime });
      startMusicRaf();
      return true;
    },
    [getAudioContext, stopSourceNode, handleSourceEnded, startMusicRaf]
  );

  // decodeAudioData()はPromiseを返すのが現行仕様だが、成功/失敗コールバックも同時に渡せる
  // （古い実装向けの後方互換）。ArrayBufferはdecode後に無効化される実装があるため、
  // 呼び出しは必ず1回だけにする（resolve/rejectは呼び出し済みなら以後は無視されるため、
  // Promise版・callback版の両方を同時に登録しても二重解決の問題は起きない）。
  function decodeAudioDataCompat(audioContext, arrayBuffer) {
    return new Promise((resolve, reject) => {
      const maybePromise = audioContext.decodeAudioData(arrayBuffer, resolve, reject);
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(resolve, reject);
      }
    });
  }

  // ファイル読み込みのメインパイプライン（1章のゴールそのもの）：
  //   File → ArrayBuffer → AudioContext.decodeAudioData() → AudioBuffer → duration取得
  // 各段階の成否をmusicDiagnosticsへ記録し（28・29章）、失敗した段階に応じて
  // 「File→ArrayBuffer取得失敗」と「decode失敗」を混同しないようメッセージ・ログを分ける（3・26章）。
  const loadMusicFile = useCallback(
    async (file) => {
      const myGeneration = beginNewMusicLoadGeneration(); // 12章：この呼び出し固有の世代を発行
      const previousAsset = getMusicAsset(work); // 差し替え前の参照（IndexedDBの孤児判定・cleanup用）

      // 新しいファイルへの差し替え時は、まず現在の再生・rAF・古いAudioBufferを止める（23章）。
      stopSourceNode();
      cancelMusicRaf();
      musicOffsetSecRef.current = 0;
      musicStartedAtContextTimeRef.current = 0;
      audioBufferRef.current = null;
      musicFileRef.current = file;

      setMusicCurrentTime(0);
      setMusicError(null);
      setMusicStatus("reading");
      setMusicMeta({ fileName: file.name || "", durationSec: null, bpmSource: "manual", startOffsetSec: 0 });
      setMusicDiagnostics({
        fileSelected: { name: file.name, type: file.type, size: file.size },
        arrayBufferLoaded: null,
        decoded: null,
        duration: null,
        sampleRate: null,
        numberOfChannels: null,
        contextState: null,
        sourceStarted: null,
        lastError: null,
      });

      // ① File → ArrayBuffer
      let arrayBuffer;
      try {
        arrayBuffer = await file.arrayBuffer();
      } catch (err) {
        console.error("[Music] file.arrayBuffer() failed", { fileName: file.name, fileType: file.type, err });
        if (musicLoadGenerationRef.current !== myGeneration) return; // 12章：他Projectへ切替済みなら以後は何もしない
        setMusicStatus("error");
        setMusicError("ファイルの読み込みに失敗しました（ArrayBuffer取得エラー）。");
        setMusicDiagnostics((prev) =>
          prev ? { ...prev, lastError: { stage: "arrayBuffer", message: String((err && err.message) || err) } } : prev
        );
        return;
      }
      // 差し替えレース対策：await中に別のファイルが選ばれていたら、この結果は捨てる
      if (musicFileRef.current !== file) return;
      if (musicLoadGenerationRef.current !== myGeneration) return; // 12章
      setMusicDiagnostics((prev) => (prev ? { ...prev, arrayBufferLoaded: { byteLength: arrayBuffer.byteLength } } : prev));
      setMusicStatus("decoding");

      // ② AudioContext取得（無ければこの環境はWeb Audio API非対応）
      const ctx = getAudioContext();
      if (!ctx) {
        if (musicLoadGenerationRef.current !== myGeneration) return;
        setMusicStatus("error");
        setMusicError("この環境ではWeb Audio APIが利用できません。");
        setMusicDiagnostics((prev) => (prev ? { ...prev, lastError: { stage: "context", message: "AudioContext unavailable" } } : prev));
        return;
      }

      // ③ decodeAudioData → AudioBuffer
      let audioBuffer;
      try {
        audioBuffer = await decodeAudioDataCompat(ctx, arrayBuffer);
      } catch (err) {
        console.error("[Music] decodeAudioData failed", {
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
          err,
        });
        if (musicLoadGenerationRef.current !== myGeneration) return;
        setMusicStatus("error");
        setMusicError("この音楽ファイルを解析できませんでした。");
        setMusicDiagnostics((prev) =>
          prev
            ? { ...prev, decoded: { ok: false }, lastError: { stage: "decode", message: String((err && err.message) || err) } }
            : prev
        );
        return;
      }
      if (musicFileRef.current !== file) return; // 差し替えレース対策（decode完了後にも再チェック）
      if (musicLoadGenerationRef.current !== myGeneration) return; // 12章：decode完了時点でも再チェック

      // ④ duration / sampleRate / numberOfChannels 取得（6・7・8章の診断基準）
      audioBufferRef.current = audioBuffer;
      const durationSec = audioBuffer.duration;
      setMusicMeta((prev) => ({ ...prev, durationSec: Number.isFinite(durationSec) ? durationSec : null }));
      setMusicStatus("ready");
      setMusicDiagnostics((prev) =>
        prev
          ? {
              ...prev,
              decoded: { ok: true },
              duration: durationSec,
              sampleRate: audioBuffer.sampleRate,
              numberOfChannels: audioBuffer.numberOfChannels,
            }
          : prev
      );
      console.info("[Music] decoded", {
        duration: durationSec,
        sampleRate: audioBuffer.sampleRate,
        numberOfChannels: audioBuffer.numberOfChannels,
        length: audioBuffer.length,
      });

      // ⑤ Project別音源管理v1：ここまで来て初めて「有効な音源」と確定したので、
      // IndexedDBへ保存し、現在ProjectのmusicAssetをこの新しい音源へ差し替える（9章）。
      // decode前（＝壊れたファイル）の段階ではIndexedDBへは書き込まない。
      const newAssetId = makeId("music");
      const saved = await idbPutMusicAsset({
        id: newAssetId,
        blob: file,
        fileName: file.name || "",
        mimeType: file.type || "",
        savedAt: new Date().toISOString(),
      });
      if (musicLoadGenerationRef.current !== myGeneration) return; // 12章：保存中にProjectが切り替わっていたら中断
      if (!saved) {
        // 15章：保存に失敗しても、このセッション中の再生自体は継続できるようにする
        // （audioBufferRefは既に設定済み＝ready状態のまま）。ただし次回リロード時には
        // 復元できない旨をdiagnosticsへ残すに留め、致命的エラー表示にはしない。
        console.warn("[Music] IndexedDBへの保存に失敗しました。今回のセッションでは再生できますが、次回リロード時には復元できません。");
        setMusicDiagnostics((prev) => (prev ? { ...prev, lastError: { stage: "idb-save", message: "IndexedDB save failed" } } : prev));
        return;
      }

      // 現在Projectのwork.project.musicAssetを新しい参照へ差し替える。commitWorkではなく
      // updateWorkLiveを使うことで、この操作自体はUndo/Redo履歴に1件として積まれない
      // （13章・U：音源load/save操作がUndo/Redo履歴に混入しないようにする）。
      updateWorkLive((prev) => ({
        ...prev,
        project: { ...prev.project, musicAsset: { id: newAssetId, fileName: file.name || "", mimeType: file.type || "" } },
      }));

      // 古い音源（差し替え前）が、他のどのProjectからも参照されていなければIndexedDBから削除する（8・9章）。
      // 現在Projectは既に新しいassetIdを指しているため、workspace.activeProjectIdを除外して判定すれば十分
      // （workspace側の反映タイミング＝useEffectの実行を待つ必要がない）。
      if (previousAsset && previousAsset.id !== newAssetId) {
        const stillReferenced = isMusicAssetReferencedByAnyProject(workspace, previousAsset.id, workspace.activeProjectId);
        if (!stillReferenced) {
          idbDeleteMusicAsset(previousAsset.id).catch(() => {});
        }
      }
    },
    [stopSourceNode, cancelMusicRaf, getAudioContext, beginNewMusicLoadGeneration, work, workspace, updateWorkLive]
  );

  // ファイル選択（<input type="file" accept="audio/*">のonChange）。実処理はloadMusicFileへ委譲する。
  const handleMusicFileChange = useCallback(
    (e) => {
      const input = e.target;
      const file = input.files && input.files[0];
      // 同じファイルを選び直してもonChangeが発火するよう、input自体は毎回リセットする
      input.value = "";
      if (!file) return;
      loadMusicFile(file);
    },
    [loadMusicFile]
  );

  // 音楽を「今の位置を保持したまま」一時停止する共通処理（14・15章の▶/⏸トグルにあった
  // 「現在位置を計算してmusicOffsetSecRefへ保存しSourceNodeを止める」ロジックをそのまま抽出）。
  // 手動の▶/⏸トグル（すぐ下のhandleMusicPlayPause）と、後述のMusic Sync Playback v1の
  // 一時停止（pauseSyncPlayback）の両方から呼べるようにし、同じ処理を二重実装しない
  // （Music Sync Playback v1・4章「既存ロジックを再利用し、二重実装しない」という方針を、
  // 音楽の一時停止処理にも同様に適用したもの。動作自体はこれまでと完全に同一）。
  const pauseMusicKeepingPosition = useCallback(() => {
    if (musicStatus !== "playing") return;
    const ctx = audioContextRef.current;
    const buffer = audioBufferRef.current;
    if (ctx && buffer) {
      const elapsed = ctx.currentTime - musicStartedAtContextTimeRef.current;
      const pos = clamp(musicOffsetSecRef.current + elapsed, 0, buffer.duration);
      musicOffsetSecRef.current = pos;
      setMusicCurrentTime(pos);
    }
    stopSourceNode();
    cancelMusicRaf();
    setMusicStatus("paused");
  }, [musicStatus, stopSourceNode, cancelMusicRaf]);

  // ▶/⏸ トグル（14・15章）。
  //   再生中に押した場合   ：pauseMusicKeepingPosition()で現在位置を保持したまま停止する
  //                          （0秒へは戻さない＝15章）。
  //   ready/paused中に押した場合：musicOffsetSecRefに保存済みの位置（初回なら0）から新しい
  //                          SourceNodeで再生を開始する（7章：途中位置からの再開）。
  const handleMusicPlayPause = useCallback(async () => {
    if (musicStatus === "playing") {
      pauseMusicKeepingPosition();
      return;
    }
    if (musicStatus !== "ready" && musicStatus !== "paused") return; // reading/decoding/error/idle中は何もしない
    await startPlaybackFrom(musicOffsetSecRef.current);
  }, [musicStatus, pauseMusicKeepingPosition, startPlaybackFrom]);

  // 音楽専用スクラバー（構成間アニメーション用スクラバーとは完全に別物＝20章）。
  //   再生中にシーク   ：現在のSourceNodeを止め、新しい位置から即座に再生を続ける（22章。playing状態を維持）。
  //   一時停止中にシーク：musicOffsetSecRefと表示だけ更新し、再生は開始しない（21章）。
  const handleMusicSeek = useCallback(
    (e) => {
      const buffer = audioBufferRef.current;
      if (!buffer) return;
      const val = Number(e.target.value);
      if (!Number.isFinite(val)) return;
      const clampedVal = clamp(val, 0, buffer.duration);
      if (musicStatus === "playing") {
        startPlaybackFrom(clampedVal);
      } else if (musicStatus === "ready" || musicStatus === "paused") {
        musicOffsetSecRef.current = clampedVal;
        setMusicCurrentTime(clampedVal);
      }
    },
    [musicStatus, startPlaybackFrom]
  );

  // 「音楽を外す」（24章）：SourceNode停止・rAF停止・AudioBuffer解放・オフセット/durationリセット。
  // project.bpmには一切触れない。AudioContext自体はここではcloseしない（次のファイル選択で
  // 再利用できるようにするため。close/recreateの繰り返しを避ける＝36章）。
  //
  // 【Project別音源管理v1・重要】この関数は「Audio Runtimeを止めて空にするだけ」であり、
  // work.project.musicAsset（Projectに登録された音源の参照）にもIndexedDB本体にも
  // 一切触れない（5章：「再生runtimeを停止すること」と「Projectに登録された音源そのものを
  // 削除すること」は完全に分離する）。
  //   ・Project切替時のcleanup            → この関数だけを呼ぶ（restoreMusicForProjectの内部で使用）
  //   ・ユーザーが明示的に「音楽を外す」   → handleRemoveMusicAsset()（この関数 + work更新 + IndexedDB cleanup）
  const removeMusic = useCallback(() => {
    stopSourceNode();
    cancelMusicRaf();
    audioBufferRef.current = null;
    musicFileRef.current = null;
    musicOffsetSecRef.current = 0;
    musicStartedAtContextTimeRef.current = 0;
    setMusicCurrentTime(0);
    setMusicStatus("idle");
    setMusicError(null);
    setMusicDiagnostics(null);
    setMusicMeta({ fileName: "", durationSec: null, bpmSource: "manual", startOffsetSec: 0 });
  }, [stopSourceNode, cancelMusicRaf]);

  // Project別音源管理v1のメインパイプライン（5・11章）：
  //   1. 再生停止・SourceNode/rAF cleanup（removeMusic()を再利用）
  //   2. 対象Projectのwork.project.musicAssetを確認
  //   3. あればIndexedDBから該当Blobを取得
  //   4. ArrayBuffer化 → decodeAudioData() → AudioBuffer
  //   5. runtimeへ設定 → MusicBarをready状態へ復元
  // Project切替・Project新規作成・Project複製・Project削除（fallback先）・ページ再読み込みの
  // 5箇所すべてから、この1つの関数だけを呼ぶ（同じ復元ロジックを重複実装しない）。
  // 非同期処理のため、実行中に他のProjectへ切り替わった場合はmusicLoadGenerationRefで検出し、
  // 古い結果をruntimeへ反映しない（12章）。
  const restoreMusicForProject = useCallback(
    async (project) => {
      const myGeneration = beginNewMusicLoadGeneration();
      const asset = getMusicAsset(project && project.work);

      // まずruntimeを「未読み込み」へ揃える。前Projectの音源情報が一瞬でも見えないようにする。
      removeMusic();
      if (!asset) return { status: "no-asset" }; // 6章：新規Project等、音源が無いProjectはここで終了

      setMusicStatus("reading");
      setMusicMeta({ fileName: asset.fileName, durationSec: null, bpmSource: "manual", startOffsetSec: 0 });
      setMusicDiagnostics({
        fileSelected: { name: asset.fileName, type: asset.mimeType, size: null },
        arrayBufferLoaded: null,
        decoded: null,
        duration: null,
        sampleRate: null,
        numberOfChannels: null,
        contextState: null,
        sourceStarted: null,
        lastError: null,
      });

      let record;
      try {
        record = await idbGetMusicAsset(asset.id);
      } catch (err) {
        record = null;
      }
      if (musicLoadGenerationRef.current !== myGeneration) return { status: "superseded" }; // 12章

      if (!record || !record.blob) {
        // 15章：IndexedDB側にデータが無い／取得失敗 → 「未読み込み」へ安全にfallbackする。
        // Workspace（Project構成データ）自体はここでは一切書き換えない。
        console.warn("[Music] IndexedDBに音源が見つかりませんでした。再度ファイルを選択してください。", { assetId: asset.id });
        setMusicStatus("idle");
        setMusicMeta({ fileName: asset.fileName, durationSec: null, bpmSource: "manual", startOffsetSec: 0 });
        setMusicDiagnostics(null);
        return { status: "missing", assetId: asset.id };
      }

      let arrayBuffer;
      try {
        arrayBuffer = await record.blob.arrayBuffer();
      } catch (err) {
        if (musicLoadGenerationRef.current !== myGeneration) return { status: "superseded" };
        console.error("[Music] restored blob.arrayBuffer() failed", err);
        setMusicStatus("error");
        setMusicError("保存済みの音源を読み込めませんでした。再度ファイルを選択してください。");
        return { status: "error", stage: "arrayBuffer" };
      }
      if (musicLoadGenerationRef.current !== myGeneration) return { status: "superseded" }; // 12章

      const ctx = getAudioContext();
      if (!ctx) {
        setMusicStatus("error");
        setMusicError("この環境ではWeb Audio APIが利用できません。");
        return { status: "error", stage: "context" };
      }
      setMusicStatus("decoding");

      let audioBuffer;
      try {
        audioBuffer = await decodeAudioDataCompat(ctx, arrayBuffer);
      } catch (err) {
        if (musicLoadGenerationRef.current !== myGeneration) return { status: "superseded" };
        console.error("[Music] restored decodeAudioData failed", err);
        setMusicStatus("error");
        setMusicError("この音楽ファイルを解析できませんでした。");
        return { status: "error", stage: "decode" };
      }
      if (musicLoadGenerationRef.current !== myGeneration) return { status: "superseded" }; // 12章：最終ガード

      audioBufferRef.current = audioBuffer;
      const durationSec = audioBuffer.duration;
      setMusicMeta({
        fileName: asset.fileName,
        durationSec: Number.isFinite(durationSec) ? durationSec : null,
        bpmSource: "manual",
        startOffsetSec: 0,
      });
      setMusicStatus("ready");
      setMusicDiagnostics({
        fileSelected: { name: asset.fileName, type: asset.mimeType, size: record.blob.size != null ? record.blob.size : null },
        arrayBufferLoaded: { byteLength: arrayBuffer.byteLength },
        decoded: { ok: true },
        duration: durationSec,
        sampleRate: audioBuffer.sampleRate,
        numberOfChannels: audioBuffer.numberOfChannels,
        contextState: ctx.state,
        sourceStarted: null,
        lastError: null,
      });
      console.info("[Music] restored from IndexedDB", {
        assetId: asset.id,
        duration: durationSec,
        sampleRate: audioBuffer.sampleRate,
      });
      return { status: "restored", assetId: asset.id };
    },
    [beginNewMusicLoadGeneration, removeMusic, getAudioContext]
  );

  // 「音楽を外す」ボタン専用ハンドラ（10章）：現在Projectだけに作用する。
  //   1. 進行中の非同期音源loadがあれば世代を進めて無効化する
  //   2. removeMusic()でruntimeだけを止める
  //   3. 現在Projectのwork.project.musicAssetをnullへ（updateWorkLive＝Undo/Redo対象外）
  //   4. 外した音源が他のどのProjectからも参照されていなければIndexedDBから削除する
  // 他Projectに登録されているmusicAssetには一切触れない。
  const handleRemoveMusicAsset = useCallback(() => {
    const currentAsset = getMusicAsset(work);
    beginNewMusicLoadGeneration();
    removeMusic();
    if (!currentAsset) return;
    updateWorkLive((prev) => ({ ...prev, project: { ...prev.project, musicAsset: null } }));
    const stillReferenced = isMusicAssetReferencedByAnyProject(workspace, currentAsset.id, workspace.activeProjectId);
    if (!stillReferenced) {
      idbDeleteMusicAsset(currentAsset.id).catch(() => {});
    }
  }, [work, workspace, beginNewMusicLoadGeneration, removeMusic, updateWorkLive]);

  // アンマウント時のcleanup（23・36章）：SourceNode停止・rAF停止・AudioContextのclose。
  // 依存配列が安定した関数のみ（すべてuseCallback([])由来）のため、このeffect自体は
  // マウント・アンマウントの1回ずつしか実行されない（React Strict Modeの開発時二重実行に対しても、
  // 実際のAudioContext生成はここではなく遅延生成のため安全＝37章）。
  useEffect(() => {
    return () => {
      stopSourceNode();
      cancelMusicRaf();
      const ctx = audioContextRef.current;
      if (ctx && typeof ctx.close === "function" && ctx.state !== "closed") {
        ctx.close().catch(() => {});
      }
      audioContextRef.current = null;
      audioBufferRef.current = null;
    };
  }, [stopSourceNode, cancelMusicRaf]);

  // 将来の「秒数⇔カウント/エイト」拡張（16・17・21章）への土台。durationSec・projectBpmが
  // 揃った時点で総カウント数・総エイト数を計算できる（今回はメイン表示にはしない＝16章）。
  // ここで計算しておくことで、将来「第Nエイト→秒数区間」「秒数→エイト」検索UIや
  // 音楽同期再生を実装する際、この2値をそのまま渡すだけで済む構造にしてある。
  const musicTotalCounts = musicMeta.durationSec != null ? secondsToCounts(musicMeta.durationSec, projectBpm) : null;
  const musicTotalEighths = musicTotalCounts != null ? countsToEighths(musicTotalCounts) : null;

  const currentSlide = slides[currentSlideIndex];
  const placements = currentSlide.placements;

  // ステージ下部に表示する「現在の順番 / 全構成数　構成名」用のラベル。
  // 桁数はslides.lengthに合わせて自動調整し、最低2桁でゼロ埋めする（100構成以上でも自然に3桁になる）。
  const slideOrderDigits = Math.max(2, String(slides.length).length);
  const slideOrderLabel = String(currentSlideIndex + 1).padStart(slideOrderDigits, "0");
  const slideTotalLabel = String(slides.length).padStart(slideOrderDigits, "0");

  // ---- 構成（スライド）切替・作成 ----
  // 構成の切り替え（前へ／次へ／カード選択）は「見た目の切り替え」として扱い、
  // Undo/Redo履歴には積まない（commitWorkではなくupdateWorkLiveを使う）。
  const goToSlide = useCallback(
    (index) => {
      updateWorkLive((prev) => {
        const clampedIndex = clamp(index, 0, prev.slides.length - 1);
        if (clampedIndex === prev.currentSlideIndex) return prev;
        return { ...prev, currentSlideIndex: clampedIndex };
      });
    },
    [updateWorkLive]
  );
  const goToPrevSlide = useCallback(() => goToSlide(currentSlideIndex - 1), [goToSlide, currentSlideIndex]);
  const goToNextSlide = useCallback(() => goToSlide(currentSlideIndex + 1), [goToSlide, currentSlideIndex]);

  // ------------------------------------------------------------
  // 構成間移動アニメーション（単体再生・連続再生）
  // ------------------------------------------------------------
  // 表示専用の一時的なUI state。slides / placements（作品データ）には一切保存しない。
  //   playbackState : "idle"（停止中） | "playing"（再生中） | "paused"（一時停止中）
  //   playbackMode  : "single"（▶＝現在→次の1回だけ） | "continuous"（▶▶＝現在から最後まで連続）
  //     ※ 一時停止中もこの値を保持したままにし、▶（またはこのすぐ下のresumeFromPause）で
  //       再開したときに「単体を再開したのか連続を再開したのか」が曖昧にならないようにする。
  //   phase         : "move"（構成と構成の間を移動中） | "keep"（構成そのものを維持中）
  //     ※ singleでは常に"move"（keepフェーズはcontinuous専用の概念）。
  //   fromIndex/toIndex: moveフェーズ＝移動元／移動先の構成index。
  //     keepフェーズ＝キープ対象の構成index（fromIndexのみ使う。toIndexはnull）。
  //   progress      : 0〜1の進捗（moveフェーズ＝補間progress、keepフェーズ＝キープ経過progress。
  //     用途はphaseで判別する＝ここのprogressは常に「今アニメーション中の値」という1つの意味に統一する）
  const [animationState, setAnimationState] = useState(IDLE_ANIMATION_STATE);

  // rAFのID・開始時刻など「毎フレーム変わるがそれ自体では再レンダーを起こしたくない」情報はrefで持つ。
  // animationRef.current.isPlaying は、setAnimationStateの反映（非同期）を待たずに
  // 連打（同時に複数のrAFループが走ること）を防ぐための同期的なフラグとして使う
  // （「playing」中だけtrue。一時停止・停止・完了ではfalseに戻す）。
  // mode/phaseは、pauseTransitionなど「今どのフェーズを止めているか」を同期的に読みたい箇所で使う
  // （animationStateの反映を待たなくてよいミラー）。
  const animationRef = useRef({
    isPlaying: false,
    rafId: null,
    startTime: null,
    mode: "single",
    phase: "move",
    fromIndex: null,
    toIndex: null,
    duration: countsToDurationMs(DEFAULT_TRANSITION_COUNTS, projectBpm), // 初期値（実際の再生時は都度上書きされる）
    startProgress: 0, // 今回の再生区間の開始progress（0からの通常再生、または一時停止/スクラバー位置からの再開）
    progress: 0, // 現在のprogress（rAFループ内で毎フレーム更新するミラー）
  });

  const cancelAnimationLoop = useCallback(() => {
    if (animationRef.current.rafId != null) {
      cancelAnimationFrame(animationRef.current.rafId);
      animationRef.current.rafId = null;
    }
  }, []);

  // 「今のcurrentSlideIndexの変化が、再生エンジン自身による自動進行（連続再生でのkeep→move進行など）
  // なのか、ユーザーによる手動切替（前後ボタン・構成カードクリックなど）なのか」を区別するためのフラグ。
  // 再生エンジンが内部でgoToSlideを呼ぶ直前に必ずtrueへ立て、下のuseEffect側で1回だけ消費してfalseへ戻す。
  // これにより、連続再生中にcurrentSlideIndexが進んでも（内部由来なので）再生状態が誤ってリセットされず、
  // 逆にユーザーが手動で構成を変えた場合（内部由来ではないので）は24章の通り確実にリセットされる。
  const internalSlideAdvanceRef = useRef(false);

  // ==============================================================
  // 構成間アニメーション・スクラバー（手動プレビュー用）
  // ==============================================================
  // 「現在の構成→次の構成」の途中状態をスライダーで手動確認できる機能。試験導入を経て、
  // 使い勝手が良いことが確認できたため正式機能として採用した。
  //
  // scrubProgress：0〜1のUI専用state。slides / placements / transitionPaths /
  // transitionCounts など「作品データ」には一切保存しない。Undo/Redoの対象外。
  // 再生エンジンの各関数（このすぐ下で定義）から参照するため、それらより前で宣言している。
  const [scrubProgress, setScrubProgress] = useState(0);

  // 一時停止：その瞬間のprogressを保持したままアニメーションを止める（開始位置へは戻さない）。
  // playbackMode/phase/fromIndex/toIndexは維持したままにする（再開・ラベル表示に使う＝14章）。
  // moveフェーズの一時停止のみ、その瞬間のprogressをscrubProgress（Single Source of Truth）へ
  // コピーする。keepフェーズにはスクラバーの概念がないため（15章）、scrubProgressには触れず
  // 0のままにしておく（displayPlacementsWithScrub側もisKeepPhase中は無条件でscrubを無視する
  // ため、実害はないが、値としても意味のある0を保つ）。
  function pauseTransition() {
    if (!animationRef.current.isPlaying) return; // 再生中でなければ何もしない（単体・連続どちらも）
    cancelAnimationLoop();
    animationRef.current.isPlaying = false;
    animationRef.current.startTime = null;
    const pausedProgress = clamp(animationRef.current.progress, 0, 1);
    setAnimationState((prev) => ({ ...prev, playbackState: "paused", progress: pausedProgress }));
    if (animationRef.current.phase === "move") {
      setScrubProgress(pausedProgress);
    }
  }

  // 全アニメーションを強制的にidleへ戻す共通処理。
  // 用途：(a) 連続再生が最後の構成のkeepフェーズまで完了して自然終了する場合、
  //       (b) 最後の構成でkeepCounts=0のため何もせず即終了する場合、
  //       (c) 想定外にslideデータが見つからない場合の安全側フォールバック。
  // いずれもcurrentSlideIndexそのものには触れない（＝最後に表示していた構成をそのまま残す。
  // 23章「構成1へ戻さないでください」の通り）。
  function forceIdle() {
    animationRef.current.isPlaying = false;
    animationRef.current.rafId = null;
    cancelAnimationLoop();
    setAnimationState(IDLE_ANIMATION_STATE);
    setScrubProgress(0);
  }

  // ------------------------------------------------------------
  // 「編集に戻る」（PART B・新規）
  // ------------------------------------------------------------
  // 一時停止中の再生セッション（単体・連続を問わない）を明示的に終了し、編集画面へ戻るための操作。
  // 一時停止（pauseTransition）とは別の操作として提供する：一時停止は「途中位置を保持して
  // あとで再開する」ためのものだが、これは「このセッション自体をやめる」ための操作（5章）。
  //
  // 中身は既存のforceIdle()をそのまま呼ぶだけで、新しい状態やロジックは増やさない。
  // forceIdle()はanimationState/animationRef/scrubProgressというUI専用stateしか触らず、
  // work（slides[].placements等の作品データ）には一切書き込まないため、
  //   ・途中の補間位置（scrubProgressやanimationState.progress）がplacementsへ保存されることはない（9章）
  //   ・呼び出し後はdisplayPlacementsWithScrubが自動的にcurrentSlideIndexに対応する
  //     正式なslide.placementsを再表示する（isAnimationRunning=false かつ scrubProgress=0 になるため）
  //   ・work自体を変更しないためUndo/Redo履歴も一切増えない（10章）
  //   ・dataEditLocked（＝isTransitionActive）もplaybackState==="idle"になることで自動的にfalseへ戻り、
  //     編集ロックも解除される（8章）
  // という9・10・8章の要件がすべて自動的に満たされる。
  function returnToEdit() {
    if (animationState.playbackState !== "paused") return; // 一時停止中以外からは呼ばれない想定（保険）
    forceIdle();
  }

  // 共通rAFエンジン：単体再生のmove、連続再生のmove・keep、そのすべてをこの1つの関数で処理する
  // （フェーズや再生モードごとに別々のアニメーション処理は作らない）。
  // progressの計算式は既存の単体再生と全く同じ
  //   progress = startProgress + (1 - startProgress) * localProgress
  // で、これを「移動の補間progress」だけでなく「キープの経過progress」にも共通して使う
  // （キープはただ経過時間を測るだけなので、この式がそのまま使える＝別ロジックを作らない）。
  // フェーズ完了時に何をするか（次のフェーズへ進む／連続再生を終える／単体再生を終える等）は、
  // 呼び出し側が onComplete コールバックとして渡す（このエンジン自体は「次に何のフェーズか」を
  // 一切知らない＝単体・連続の分岐ロジックをこの関数の外に閉じ込める）。
  function runPhase({ mode, phase, fromIndex, toIndex, fullDurationMs, startProgress, onComplete }) {
    cancelAnimationLoop();
    const clampedStart = clamp(startProgress, 0, 1);
    animationRef.current.isPlaying = true;
    animationRef.current.startTime = null;
    animationRef.current.mode = mode;
    animationRef.current.phase = phase;
    animationRef.current.fromIndex = fromIndex;
    animationRef.current.toIndex = toIndex;
    // remainingDuration = fullDuration × (1 − startProgress)：残りprogressに応じて時間を短くする
    animationRef.current.duration = fullDurationMs * (1 - clampedStart);
    animationRef.current.startProgress = clampedStart;
    animationRef.current.progress = clampedStart;
    setAnimationState({
      playbackState: "playing",
      playbackMode: mode,
      phase,
      fromIndex,
      toIndex,
      progress: clampedStart,
    });

    const step = (timestamp) => {
      // 一時停止等で途中キャンセルされていたら何もしない（古いループの生き残り対策）
      if (!animationRef.current.isPlaying) return;
      if (animationRef.current.startTime == null) {
        animationRef.current.startTime = timestamp;
      }
      const elapsed = timestamp - animationRef.current.startTime;
      const duration = animationRef.current.duration > 0 ? animationRef.current.duration : 1;
      const localProgress = clamp(elapsed / duration, 0, 1);
      const progress = animationRef.current.startProgress + (1 - animationRef.current.startProgress) * localProgress;

      if (localProgress >= 1) {
        animationRef.current.isPlaying = false;
        animationRef.current.rafId = null;
        animationRef.current.progress = 1;
        onComplete();
        return;
      }

      animationRef.current.progress = progress;
      setAnimationState((prev) => ({ ...prev, progress }));
      animationRef.current.rafId = requestAnimationFrame(step);
    };
    animationRef.current.rafId = requestAnimationFrame(step);
  }

  // ---- 単体再生（▶＝現在の構成 → 次の構成だけ） ----
  // 移動完了時の処理：内部フラグを立ててからcurrentSlideIndexを次へ進め、再生状態をidleへ戻す。
  function completeSingleMove(toIndex) {
    internalSlideAdvanceRef.current = true;
    setAnimationState(IDLE_ANIMATION_STATE);
    setScrubProgress(0); // 再生完了時もスクラバーを0へ戻す（保険。currentSlideIndex変化時のuseEffectでも同様にリセットされる）
    goToSlide(toIndex);
  }

  // idle状態から単体再生を新規に開始する。開始位置（startProgress）は、常に
  // 「現在表示されている位置＝現在のscrubProgress」を使う（0のままなら通常通り0から、
  // スクラバーで途中位置へ動かしていた場合はその位置から）。
  function startSingleFresh() {
    if (animationRef.current.isPlaying) return; // 連打防止
    if (currentSlideIndex >= slides.length - 1) return; // 最後の構成では再生しない

    const fromIndex = currentSlideIndex;
    const toIndex = currentSlideIndex + 1;
    const counts = getTransitionCounts(transitionCounts, slides[fromIndex].id);
    // Section BPM反映 v1：move phaseは移動元（fromIndex）側のMusic Section BPMを使う
    // （getEffectiveBpmForSlide参照。Section未特定ならprojectBpmへfallback）。
    const bpm = getEffectiveBpmForSlide(slides, fromIndex, musicSections, transitionCounts, projectBpm);
    const fullDurationMs = countsToDurationMs(counts, bpm);
    const startProgress = clamp(scrubProgress, 0, 1);

    if (startProgress >= 1) {
      // 既に終端位置（4/4count等）から再生しようとした場合は、そのまま次の構成へ切り替えて終える
      internalSlideAdvanceRef.current = true;
      setAnimationState(IDLE_ANIMATION_STATE);
      setScrubProgress(0);
      goToSlide(toIndex);
      return;
    }

    runPhase({
      mode: "single",
      phase: "move",
      fromIndex,
      toIndex,
      fullDurationMs,
      startProgress,
      onComplete: () => completeSingleMove(toIndex),
    });
  }

  // 一時停止からの再開（単体・連続共通）。一時停止した瞬間のplaybackMode/phase/fromIndex/toIndex/
  // progressをanimationState（＝一時停止中はSingle Source of Truth）からそのまま読み取り、
  // 「残り時間」だけを使って同じフェーズをそのまま続きから再開する（最初からやり直さない＝14章）。
  function resumeFromPause() {
    if (animationRef.current.isPlaying) return; // 連打防止
    if (animationState.playbackState !== "paused") return;
    const { playbackMode: mode, phase, fromIndex, toIndex, progress } = animationState;
    const startProgress = clamp(progress, 0, 1);

    if (phase === "keep") {
      const slide = slides[fromIndex];
      if (!slide) {
        forceIdle();
        return;
      }
      const keep = getKeepCounts(slide);
      // Section BPM反映 v1：keep phaseはそのslide自身のMusic Section BPMを使う。
      const keepBpm = getEffectiveBpmForSlide(slides, fromIndex, musicSections, transitionCounts, projectBpm);
      const fullDurationMs = countsToDurationMs(keep, keepBpm);
      runPhase({
        mode,
        phase: "keep",
        fromIndex,
        toIndex: null,
        fullDurationMs,
        startProgress,
        onComplete: () => afterKeepForIndex(fromIndex),
      });
      return;
    }

    // phase === "move"（単体・連続どちらもここに来る）
    const fromSlide = slides[fromIndex];
    const toSlide = slides[toIndex];
    if (!fromSlide || !toSlide) {
      forceIdle();
      return;
    }
    const counts = getTransitionCounts(transitionCounts, fromSlide.id);
    // Section BPM反映 v1：move phaseは移動元（fromIndex）側のMusic Section BPMを使う。
    const moveBpm = getEffectiveBpmForSlide(slides, fromIndex, musicSections, transitionCounts, projectBpm);
    const fullDurationMs = countsToDurationMs(counts, moveBpm);
    runPhase({
      mode,
      phase: "move",
      fromIndex,
      toIndex,
      fullDurationMs,
      startProgress,
      onComplete: () => (mode === "continuous" ? completeContinuousMove(toIndex) : completeSingleMove(toIndex)),
    });
  }

  // ▶ボタンのクリックハンドラ：一時停止中は「今止まっているセッション」を単体・連続を問わず
  // そのまま再開する（14章「単体再生へ切り替わらないようにしてください」）。idleのときだけ
  // 新規に単体再生を開始する。
  function handlePlaySingleClick() {
    if (animationRef.current.isPlaying) return;
    // Sync Playback v1.6・2〜6・32章：同期一時停止中の再開は♫▶ボタンだけから行うようにする。
    // 通常▶はCompositionBar側で既にdisabled（canPlayTransitionFinal）になっているため通常は
    // ここへ来ないが、念のため二重にガードし、resumeSyncPlaybackは絶対に呼ばない
    // （Music Sync Playback v1時代はここでresumeSyncPlaybackを呼んでいたが、v1.6でその挙動を廃止）。
    if (syncPlayback.isActive && syncPlayback.isPaused) return;
    if (animationState.playbackState === "paused") {
      resumeFromPause();
      return;
    }
    startSingleFresh();
  }

  // ---- 連続再生（▶▶＝現在の構成から最後の構成まで、キープと移動を交互に） ----
  // 「idxの構成に到着した直後」に何をするかを決める共通の入口。
  //   keepCounts(idx) > 0 → キープフェーズを開始する。
  //   keepCounts(idx) === 0 → キープフェーズを作らず（0msのrAFループを作らない）、
  //     即座に afterKeepForIndex へ進む（8章）。
  function decidePhaseForIndex(idx) {
    const slide = slides[idx];
    if (!slide) {
      forceIdle();
      return;
    }
    const keep = getKeepCounts(slide);
    if (keep > 0) {
      startKeepPhase(idx);
    } else {
      afterKeepForIndex(idx);
    }
  }

  // 「idxのキープフェーズが終わった（または最初から無かった）直後」に何をするかを決める。
  //   次の構成がある → idx→idx+1のmoveフェーズを開始する。
  //   次の構成がない（＝idxが最後の構成） → 連続再生を終了する（11章）。
  function afterKeepForIndex(idx) {
    const hasNext = idx < slides.length - 1;
    if (!hasNext) {
      forceIdle();
      return;
    }
    startMovePhaseContinuous(idx, idx + 1);
  }

  function startKeepPhase(idx) {
    const slide = slides[idx];
    if (!slide) {
      forceIdle();
      return;
    }
    const keep = getKeepCounts(slide);
    // Section BPM反映 v1：keep phaseはそのslide自身のMusic Section BPMを使う。
    const keepBpm = getEffectiveBpmForSlide(slides, idx, musicSections, transitionCounts, projectBpm);
    const fullDurationMs = countsToDurationMs(keep, keepBpm);
    runPhase({
      mode: "continuous",
      phase: "keep",
      fromIndex: idx,
      toIndex: null,
      fullDurationMs,
      startProgress: 0,
      onComplete: () => afterKeepForIndex(idx),
    });
  }

  function startMovePhaseContinuous(fromIndex, toIndex) {
    const fromSlide = slides[fromIndex];
    if (!fromSlide) {
      forceIdle();
      return;
    }
    const counts = getTransitionCounts(transitionCounts, fromSlide.id);
    // Section BPM反映 v1：move phaseは移動元（fromIndex）側のMusic Section BPMを使う。
    const moveBpm = getEffectiveBpmForSlide(slides, fromIndex, musicSections, transitionCounts, projectBpm);
    const fullDurationMs = countsToDurationMs(counts, moveBpm);
    runPhase({
      mode: "continuous",
      phase: "move",
      fromIndex,
      toIndex,
      fullDurationMs,
      startProgress: 0,
      onComplete: () => completeContinuousMove(toIndex),
    });
  }

  // 連続再生中のmove完了時の処理：内部フラグを立ててからcurrentSlideIndexをtoIndexへ進め
  // （21章：構成カード・構成名・キープ表示などがこれに追従する）、その構成のkeepフェーズへ
  // 続ける（10章：MOVE→KEEP→MOVE→…の繰り返し）。
  //
  // Sync Playback v1.6・PART B〜E（10〜26章）：音楽＋アニメーション同期再生中（syncPlayback.isActive）
  // に限り、到達したtoIndexの構成が「実データとしての手動Music Anchor」（slide.musicAnchor。
  // effectiveMusicAnchorのような自動計算結果は含まない＝21章）を持っているかどうかを確認する。
  // 持っていれば、そこを絶対的な同期境界（sync boundary）として扱い、通常のdecidePhaseForIndexを
  // 即実行する前にhandleManualAnchorBoundaryへ処理を委譲する（23章）。
  // 手動Anchorが無い（自動Anchorのみ、またはmusicAnchor未設定）構成へは、今まで通り音楽を
  // 一切seekし直さずdecidePhaseForIndexだけを呼ぶ（14・22章：自動Anchorでは音を途切れさせない）。
  // 通常の（同期していない）▶▶連続再生では、syncPlayback.isActiveが常にfalseのため、
  // このブロックは素通りし、従来と完全に同じ挙動のまま変化しない。
  //
  // Sync Playback v1.7・PART A：この関数はrAFのonCompleteチェーンを通じて「古い世代の
  // クロージャ」から呼ばれ続ける可能性があるため（詳細はsyncPlaybackRef宣言部のコメント参照）、
  // const syncPlayback（ReactのuseState。このレンダー時点のスナップショットで固定されている）
  // ではなく、常に最新値へ同期的に更新されるsyncPlaybackRef.currentを読む。これにより、
  // startSyncPlayback()がsetSyncPlayback→decidePhaseForIndexを同じ同期実行内で呼んだ直後でも、
  // 「今まさに同期再生がアクティブになった」という事実を正しく検出できる。
  function completeContinuousMove(toIndex) {
    internalSlideAdvanceRef.current = true;
    goToSlide(toIndex);
    if (syncPlaybackRef.current.isActive) {
      const nextSlide = slides[toIndex];
      const manualAnchor = nextSlide ? getMusicAnchor(nextSlide) : null;
      if (manualAnchor) {
        handleManualAnchorBoundary(toIndex, manualAnchor);
        return;
      }
    }
    decidePhaseForIndex(toIndex);
  }

  // ---- Sync Playback v1.6・PART B〜E・PART C（10〜26章）：手動Music Anchor境界での音楽再同期 ----
  // 「構成11を直接♫▶した場合」と「連続再生で構成11へ到達した場合」とで、プリロール判定・
  // 音楽開始位置の計算を別々に実装しないよう、既存のresolveMusicPlaybackTimingForSlide()を
  // 必ず再利用する（20章）。処理の流れは24章の通り：
  //   1. startPlaybackFrom()が内部で必ずstopSourceNode()を呼ぶため、既存SourceNodeは
  //      ここで明示的に止めなくても二重再生にはならない（26章のSourceNode多重生成防止を踏襲）。
  //   2. 到達した構成の手動Anchorから、既存のmusicAnchorToTimeSec()・resolveMusicPlaybackTimingForSlide()で
  //      絶対時刻・プリロール要否を計算する（16・19・20章：keepCounts/transitionCounts/
  //      直前の音楽currentTimeより、この手動Anchorを絶対位置として優先する）。
  //   3. 再生開始モード v1：到達したtoIndexのslide自身が持つmusicPlaybackStartModeが
  //      "sectionStart"の場合、対応Music SectionのstartSecへ絶対的に巻き戻ってからプリロールする
  //      （＝直接♫▶した場合と全く同じ判定をresolveMusicPlaybackTimingForSlide内部で共有する）。
  //      それ以外（mode==="anchor"、またはtoIndexのslideに手動Anchorが無い）は、従来通り常に
  //      anchorTimeSecから音楽＋構成animationを同時に開始する。この「連続再生中も絶対的に
  //      巻き戻す」という挙動は実機確認後に変更される可能性があるため、変更が必要になった場合は
  //      resolveMusicPlaybackTimingForSlideのcontext引数（ここでは"continuous"を渡してある）で
  //      分岐を追加するだけで対応できる（この関数自体は変更不要）。
  //   4. syncPlaybackはisActive:trueのまま維持し、一度もidleへ戻さない（25章：ユーザーから見て
  //      ひとつの連続同期再生のまま）。currentSlideIndexは呼び出し元のcompleteContinuousMoveで
  //      既にtoIndexへ進めてある（26章）。
  // 29章：将来的な「Anchor差が小さければseekを省略する」といった最適化は今回は行わず、
  // 手動Anchorへ到達したら必ず再同期する（常に強制再同期）。
  async function handleManualAnchorBoundary(toIndex, manualAnchor) {
    const anchorTimeSec = musicAnchorToTimeSec(manualAnchor, musicSections);
    const section = musicSections.find((s) => s.id === manualAnchor.sectionId) || null;
    const slide = slides[toIndex] || null;
    const timing = resolveMusicPlaybackTimingForSlide(slide, manualAnchor, section, anchorTimeSec, "continuous");
    // 13章のcountStartSec<startSecのような不正なSection設定の場合は、安全側に倒して
    // 音楽をseekし直さず、通常のkeep/moveをそのまま継続する（データの自動補正はしない）。
    if (!timing || timing.musicStartSec == null || timing.animationStartSec == null || timing.prerollSec < 0) {
      decidePhaseForIndex(toIndex);
      return;
    }
    const musicStarted = await startPlaybackFrom(timing.musicStartSec);
    if (!musicStarted) {
      decidePhaseForIndex(toIndex);
      return;
    }
    if (timing.prerollSec > 0) {
      setAnimationState(PREROLL_ANIMATION_STATE);
      applySyncPlayback((prev) => ({ ...prev, isActive: true, isPaused: false, phase: "preroll", animationStartSec: timing.animationStartSec }));
    } else {
      applySyncPlayback((prev) => ({ ...prev, isActive: true, isPaused: false, phase: "active", animationStartSec: timing.animationStartSec }));
      decidePhaseForIndex(toIndex);
    }
  }

  // ▶▶（連続再生）ボタンの新規開始。常にcurrentSlideIndexから開始する（6章：構成1から
  // 始める必要はない）。
  function startContinuousFresh() {
    if (animationRef.current.isPlaying) return; // 連打防止
    decidePhaseForIndex(currentSlideIndex);
  }

  // ▶▶ボタンのクリックハンドラ：▶と同じく、一時停止中は今のセッションをそのまま再開する。
  function handlePlayContinuousClick() {
    if (animationRef.current.isPlaying) return;
    // Sync Playback v1.6・4・32章：▶と同じく、同期一時停止中はこちらのボタンからもresumeSyncPlayback
    // を呼ばない（♫▶だけが再開の入口）。CompositionBar側で既にdisabled（canPlayContinuousFinal）に
    // なっているため通常はここへ来ないが、念のため二重にガードする。
    if (syncPlayback.isActive && syncPlayback.isPaused) return;
    if (animationState.playbackState === "paused") {
      resumeFromPause();
      return;
    }
    startContinuousFresh();
  }

  // コンポーネントunmount時には必ずrAFをcancelする
  useEffect(() => {
    return () => {
      animationRef.current.isPlaying = false;
      cancelAnimationLoop();
    };
  }, [cancelAnimationLoop]);

  // isAnimationRunning：「実際にrAFで進行中」の厳密な再生中フラグ（一時停止中はfalse）。
  //   用途：▶/▶▶再生の連打防止判定・スクラバーの操作可否・再生中専用のprogress表示切替など、
  //   「今まさにrAFが動いているかどうか」を厳密に区別したい箇所でのみ使う（単体・連続を問わない）。
  // isTransitionActive：「再生中または一時停止中」＝表示が実データではなく遷移プレビュー状態。
  //   用途：Undo/Redo・出演者編集・構成の追加削除並べ替え・transitionCounts/keepCounts変更・
  //   曲線/waypoint編集・zoom/pan以外の操作全般など、「再生中は編集不可」としていたガード全般に使う
  //   （一時停止中も実データ表示ではないため、誤操作防止のため同様に編集をブロックする。25章）。
  // isKeepPhase：連続再生の「キープ中」（再生中・一時停止中どちらも含む）。スクラバーは
  //   キープフェーズには対応しないため（15章）、この値でスクラバーを強制的に無効化する。
  const isAnimationRunning = animationState.playbackState === "playing";
  const isTransitionActive = animationState.playbackState !== "idle";
  const isKeepPhase = isTransitionActive && animationState.phase === "keep";

  // ------------------------------------------------------------
  // Music Timeline / Formation Markers v1
  // ------------------------------------------------------------
  // 既存のresolveSlideMusicPosition・musicAnchorToTimeSecから毎回導出するだけの表示専用データ。
  // work（作品データ）へは一切保存しない（18章）。slides / musicSections / transitionCounts /
  // projectBpm / 音源の長さ（musicMeta.durationSec）が変わるたびに再計算するだけで、
  // 新しいReact stateも新しいタイムラインエンジンも持たない（0章・13章）。
  const formationMarkersRaw = useMemo(
    () =>
      buildFormationTimelineMarkers({
        slides,
        musicSections,
        transitionCounts,
        projectBpm,
        musicDuration: musicMeta.durationSec,
      }),
    [slides, musicSections, transitionCounts, projectBpm, musicMeta.durationSec]
  );
  // hover/title用のラベル文字列（5章）はここで組み立てる。buildFormationTimelineMarkers自体は
  // slide.name・Section名の文言整形に関与させず、14章の返り値イメージ（slideIndex/slideId/
  // timeSec/ratio/sectionId/isManualAnchor/eighthNumber/countOffset）どおりの汎用データのままにする。
  const formationMarkers = useMemo(
    () =>
      formationMarkersRaw.map((m) => {
        const slide = slides[m.slideIndex];
        const section = musicSections.find((s) => s.id === m.sectionId);
        const sectionLabel = section ? section.name : "";
        const titleText = [
          `構成 ${m.slideIndex + 1}${slide && slide.name ? "：" + slide.name : ""}`,
          `${sectionLabel ? sectionLabel + " / " : ""}${formatMusicAnchorEighthCountLabel(m.eighthNumber, m.countOffset)}`,
          m.isManualAnchor ? "手動Anchor" : "自動位置",
        ].join("\n");
        return { ...m, titleText };
      }),
    [formationMarkersRaw, slides, musicSections]
  );
  // Music Sectionの境界（startSec基準＝10章）も同じ考え方で毎回導出するだけの表示専用データ。
  const sectionBoundaryMarkers = useMemo(
    () => buildMusicSectionBoundaryMarkers(musicSections, musicMeta.durationSec),
    [musicSections, musicMeta.durationSec]
  );
  // マーカークリック時の構成切替。既存goToSlide()をそのまま再利用し（16章）、currentSlideIndexを
  // 直接バラバラな場所でsetしない。isTransitionActive（構成アニメーション再生中・一時停止中・
  // Sync Playback中のいずれもtrueになる既存の値）で、再生系操作が禁止されている間はクリックを
  // 無効化する（6章・G・H）。音楽の再生・一時停止には一切触れない（7章：goToSlide自体、
  // work.currentSlideIndexの見た目上の切替のみを行いUndo対象外＝17章）。
  const handleFormationMarkerClick = useCallback(
    (slideIndex) => {
      if (isTransitionActive) return;
      goToSlide(slideIndex);
    },
    [isTransitionActive, goToSlide]
  );
  // ▶（単体再生）：一時停止中は常に再開可能。idleのときは次の構成がある場合のみ新規開始できる。
  const canResumePlayback = animationState.playbackState === "paused";
  const canPlayTransition = !isAnimationRunning && (canResumePlayback || currentSlideIndex < slides.length - 1);
  // ▶▶（連続再生）：一時停止中は常に再開可能。idleのときは、次の構成があるか、
  // 現在の構成のキープが0より大きい（＝キープだけでも意味のある再生になる）場合に開始できる。
  const canPlayContinuous =
    !isAnimationRunning && (canResumePlayback || currentSlideIndex < slides.length - 1 || getKeepCounts(currentSlide) > 0);

  // 表示専用の座標。再生中（moveフェーズ）は「移動元の構成→移動先の構成」を補間した一時データ、
  // 再生中（keepフェーズ）は「キープ対象の構成」のplacementsをそのまま静止表示（出演者を動かさない
  // ＝7章）、それ以外は現在の構成のplacementsそのもの。TopView / OverheadAudienceView には
  // こちらを渡し、slides・performersの実データ（work）は一切変更しない。
  const displayPlacements = useMemo(() => {
    if (!isAnimationRunning || animationState.fromIndex == null) {
      return placements;
    }
    if (animationState.phase === "keep") {
      const slide = slides[animationState.fromIndex];
      return slide ? slide.placements : placements;
    }
    if (animationState.toIndex == null) return placements;
    const fromSlide = slides[animationState.fromIndex];
    const toSlide = slides[animationState.toIndex];
    if (!fromSlide || !toSlide) return placements; // 再生中にslidesが変化した場合の保険（クラッシュ防止）
    // v3：曲線モードの出演者は、直線lerp（interpolatePlacements）ではなく設定された曲線
    // （二次ベジェ）に沿って移動させる。参照する経路データも常に fromSlide.id をキーにしたものになる
    // （trajectoryMode／「前に」表示中でもここには一切影響しない＝再生機能自体は変更しない）。
    // pathConfigが無い、または曲線設定の出演者がいない場合は、この呼び出しは
    // interpolatePlacements単体を使った場合と完全に同じ結果になる。連続再生のmoveフェーズも
    // このまま再利用する（別の補間ロジックは作らない＝9章）。
    const pathConfig = effectiveTransitionPathConfig && effectiveTransitionPathConfig[fromSlide.id];
    return interpolatePlacementsWithPaths(fromSlide.placements, toSlide.placements, animationState.progress, pathConfig);
  }, [
    isAnimationRunning,
    animationState.phase,
    animationState.fromIndex,
    animationState.toIndex,
    animationState.progress,
    slides,
    placements,
    effectiveTransitionPathConfig,
  ]);

  // スクラバーの対象は常に「現在の構成→次の構成」のmoveフェーズで固定する。移動軌跡の
  // trajectoryMode（「次に」／「前に」）がどちらであっても、スクラバーの対象は
  // 変更しない（軌跡の表示方向と、アニメーション／スクラバーの対象は別物として扱う）。
  // 最後の構成では次の構成が存在しないため、スクラバーは対象外（UI側でdisabled/非表示にする）。
  const hasNextSlideForScrub = currentSlideIndex < slides.length - 1;
  const scrubTransitionCounts = hasNextSlideForScrub
    ? getTransitionCounts(transitionCounts, currentSlide.id)
    : null;
  // スクラバーの操作可否：idle・paused中（かつキープフェーズではない）は操作可能、
  // 実際にrAFが進行中（playing）、またはキープフェーズ中は操作不可にする（15章）。
  const canScrub = hasNextSlideForScrub && !isAnimationRunning && !isKeepPhase;

  // UI表示用の進捗値（Single Source of Truthの整理）：
  //   キープフェーズ中     → 0固定（スクラバーはキープに対応しないため。15章）
  //   playing中（move）    → animationState.progress をそのまま見せる（手動操作はdisabled）
  //   idle・paused中（move）→ scrubProgress を見せる（一時停止時にはanimationState.progressを
  //                          scrubProgressへコピー済みのため、一時停止位置とスクラバー位置は
  //                          常に一致する）
  const scrubDisplayProgress = isKeepPhase ? 0 : isAnimationRunning ? animationState.progress : scrubProgress;

  // 構成が手動で変更された場合（＝スクラブ／再生対象の「現在→次」ペア自体が変わった場合）は、
  // 再生・一時停止状態を解除し、scrubProgressも0へリセットする（24章）。
  // 一方、再生エンジン自身がcurrentSlideIndexを進めた場合（単体再生の完了、連続再生の
  // move完了によるkeepフェーズへの継続など）は、internalSlideAdvanceRefが立っているため
  // ここでは何もせず、再生・一時停止状態をそのまま継続させる（連続再生が構成をまたいで
  // 途切れないようにするための、今回のキー変更点）。
  useEffect(() => {
    if (internalSlideAdvanceRef.current) {
      internalSlideAdvanceRef.current = false;
      return;
    }
    setScrubProgress(0);
    setAnimationState((prev) => (prev.playbackState === "idle" ? prev : IDLE_ANIMATION_STATE));
    animationRef.current.isPlaying = false;
    cancelAnimationLoop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSlideIndex]);

  // TopView / OverheadAudienceView へ渡す最終的な表示用placements。
  // 既存の displayPlacements（▶/▶▶再生中はアニメーション結果、それ以外は実データそのもの）を
  // そのまま基本とし、「playingでない（idle・paused）、キープフェーズでもない、かつ次の構成があり、
  // かつscrubProgressが0より大きい」場合だけスクラバー位置に対応した補間結果で上書きする。
  // 直線移動・曲線移動（waypoint）とも、既存の interpolatePlacementsWithPaths を
  // そのまま再利用し、スクラバー専用の補間ロジックは作らない。
  const displayPlacementsWithScrub = useMemo(() => {
    if (isAnimationRunning) return displayPlacements; // 再生中は既存の表示（アニメーション）をそのまま使う
    if (isKeepPhase) return displayPlacements; // 一時停止中のキープフェーズはスクラバー適用外（静止表示のまま）
    if (!hasNextSlideForScrub || scrubProgress <= 0) return displayPlacements;
    const nextSlide = slides[currentSlideIndex + 1];
    if (!nextSlide) return displayPlacements;
    const pathConfig = effectiveTransitionPathConfig && effectiveTransitionPathConfig[currentSlide.id];
    return interpolatePlacementsWithPaths(currentSlide.placements, nextSlide.placements, scrubProgress, pathConfig);
  }, [
    isAnimationRunning,
    isKeepPhase,
    hasNextSlideForScrub,
    scrubProgress,
    slides,
    currentSlideIndex,
    currentSlide,
    effectiveTransitionPathConfig,
    displayPlacements,
  ]);

  // CompositionBarに渡す再生状況ラベル。単体/連続・move/keepフェーズの文字列組み立てをここに
  // 集約し、CompositionBar側は「もらった内容をそのまま表示する（nullならidle時の通常表示に
  // フォールバックする）」だけのシンプルな役割にする（フェーズ判定ロジックを二重実装しない）。
  //
  // PART A（一時停止UI 2行化）：以前は「（一時停止中）」等の再生状態サフィックスを1行目の
  // 文字列へ直接連結していたため、一時停止のたびに1行目の文字数（＝横幅）が変わっていた。
  // これを避けるため、ここでは「1行目に出す内容（main）」と「一時停止中かどうか（isPaused）」を
  // 分離したオブジェクトを返す。1行目の文字列自体はplaying/pausedで完全に同一にし、
  // 「（一時停止中）」は常にCompositionBar側の2行目（高さを常に確保した専用領域）へ表示する
  // （＝1行目の横幅にも、バー全体の高さにも一切影響しない）。
  const playbackStatusLabel = useMemo(() => {
    if (animationState.playbackState === "idle") return null;
    const isPaused = animationState.playbackState === "paused";
    // Music Timing v1.5・9・14章：プリロール（イントロ）中はfromIndex/toIndexがまだ無い
    // （PREROLL_ANIMATION_STATE）ため、「move」「keep」向けの文言をそのまま使うとundefinedな
    // 表示になってしまう。ここでは通常のidx/total表示にフォールバックし（isPausedだけは
    // 正しく伝える）、「イントロ再生中」等の専用メッセージはCompositionBar側の同期ステータス
    // バッジ（syncPlaybackPreroll/syncPrerollRemainingSec）で表示する。
    if (animationState.phase === "preroll") {
      return { main: `${currentSlideIndex + 1} / ${slides.length}`, isPaused };
    }
    // move表示統一 v1：単体（▶）・連続（▶▶）のどちらのmoveフェーズも、同じ
    // 「1 → 2　移動 2/4 count」形式で表示する（singleは常にphase==="move"のみ＝上記コメントの
    // 通りkeepフェーズを持たないため、この1つの分岐だけで両方をカバーできる）。旧仕様の
    // 「1 → 2」（単体・カウント無し）「1 → 2 連続再生」（連続）という表記の違いは廃止し、
    // 音楽同期再生側のsyncAnimationStatusLabelと同じ計算思想
    // （getTransitionCounts・roundToHalfCount・FixedCountValue）に統一した。
    // transitionCounts=0はgetTransitionCountsが明示判定でそのまま0を返すため、
    // 「移動 0/0 count」として安全に表示される（truthy判定はしていない）。
    if (animationState.phase === "move") {
      const fromIndex = animationState.fromIndex;
      const toIndex = animationState.toIndex;
      const fromSlide = slides[fromIndex];
      const moveCounts = fromSlide ? getTransitionCounts(transitionCounts, fromSlide.id) : 0;
      const currentMoveCount = roundToHalfCount(animationState.progress, moveCounts);
      return {
        main: (
          <>
            {fromIndex + 1} → {toIndex + 1}　移動 <FixedCountValue value={currentMoveCount} />/{moveCounts} count
          </>
        ),
        isPaused,
      };
    }
    // phase === "keep"：continuous専用（singleはphase="keep"にならない）。
    // キープ 3/8 count のような小さな進捗表示（16章・17章）。
    // 現在カウント部分（0.5刻みで桁数が変わる）だけFixedCountValueで固定幅にし、
    // 0.5が入るたびにUIが横へずれるのを防ぐ（他の文字列はそのままプレーンテキスト）。
    const idx = animationState.fromIndex;
    const slide = slides[idx];
    const keep = slide ? getKeepCounts(slide) : 0;
    const curCount = roundToHalfCount(animationState.progress, keep);
    return {
      main: (
        <>
          {idx + 1} キープ <FixedCountValue value={curCount} />/{keep} count
        </>
      ),
      isPaused,
    };
  }, [animationState, slides, currentSlideIndex, transitionCounts]);

  // 左端2行表示 v1：同期再生中の2行目専用の派生値。既存のplaybackStatusLabel（通常▶/▶▶の
  // 表示。上のuseMemo）は一切変更せず、それとは完全に別枠でこの値を追加する（2章：通常再生の
  // 表示仕様は変えない）。keep中の計算式は、playbackStatusLabelのkeep分岐と全く同じもの
  // （slide=slides[fromIndex]・keep=getKeepCounts(slide)・curCount=roundToHalfCount(progress,
  // keep)）を再利用し、二重実装しない（4章・6章）。move中は今回新規に、既存の
  // getTransitionCounts・roundToHalfCountだけを使って「移動 現在/設定 count」を組み立てる
  // （5章）。transitionCounts=0はhasOwnProperty方式の既存getTransitionCountsがそのまま0を
  // 返すため、0/0 countとして安全に表示される（truthy判定はしていない＝CASE D）。
  // playbackMode（single/continuous）は参照しない：phaseがmoveなら常に同じ「移動 n/m count」
  // 形式にする（6章：同期再生中に重要なのは「連続再生かどうか」ではなく、現在のphase・
  // カウントのため）。preroll中（構成アニメーションがまだ始まっていない）はnullを返し、
  // CompositionBar側で2行目の高さを保ったまま空欄にする（7章）。work・再生stateには一切
  // 保存しない、表示専用の派生値。
  const syncAnimationStatusLabel = useMemo(() => {
    if (animationState.playbackState === "idle") return null;
    if (animationState.phase === "preroll") return null;
    const fromIndex = animationState.fromIndex;
    const fromSlide = fromIndex != null ? slides[fromIndex] : null;
    if (!fromSlide) return null;
    if (animationState.phase === "move") {
      const toIndex = animationState.toIndex;
      const moveCounts = getTransitionCounts(transitionCounts, fromSlide.id);
      const currentMoveCount = roundToHalfCount(animationState.progress, moveCounts);
      return (
        <>
          {fromIndex + 1} → {toIndex + 1}　移動 <FixedCountValue value={currentMoveCount} />/{moveCounts} count
        </>
      );
    }
    // phase === "keep"：playbackStatusLabelのkeep分岐と全く同じ計算式（二重実装しない）。
    const keep = getKeepCounts(fromSlide);
    const curCount = roundToHalfCount(animationState.progress, keep);
    return (
      <>
        {fromIndex + 1} キープ <FixedCountValue value={curCount} />/{keep} count
      </>
    );
  }, [animationState, slides, transitionCounts]);

  // ------------------------------------------------------------
  // 構成間アニメーションv2：移動軌跡の表示（ON/OFF切替式・表示専用）
  // ------------------------------------------------------------
  // UI専用のstate。slides/placements等の作品データ（work）には含めず、Undo/Redoの
  // 対象外とする。構成を切り替えても、再生中でもON/OFF状態自体は維持してよい仕様。
  const [showTrajectory, setShowTrajectory] = useState(false);

  // 出演者名 v1・8章：「出演者名を表示」のON/OFFも、showTrajectoryと全く同じ考え方の
  // 表示専用UI state（work・Undo/Redoの対象外）。平面図（TopView）でだけ参照し、
  // 俯瞰客席ビューでは参照しない（9章：常に名前非表示という確定仕様のため）。
  const [showPerformerNames, setShowPerformerNames] = useState(false);

  // 軌跡の参照方向モード（v2.1で追加）。こちらもUI専用のstateで、Undo/Redo対象外。
  //   "next"     : 「次に」＝現在の構成 → 次の構成（現在の出演者が次にどこへ行くか）
  //   "previous" : 「前に」＝前の構成 → 現在の構成（現在の出演者が前にどこから来たか）
  // 将来のPDF/PNG出力（軌跡なし／「次に」の軌跡あり／「前に」の軌跡あり、を選んで出力する機能）
  // でもそのまま再利用できるよう、表示専用の独立した設定値として扱う。
  const [trajectoryMode, setTrajectoryMode] = useState("next");

  // 軌跡を、実データ（slides[].placements）から毎回計算し直す。アニメーション再生中も
  // 対象は常に「実際の現在構成」を基準にした静的な直線であり、animationStateの補間途中
  // 位置には依存しない。
  // 「どの2構成を参照するか」（getTrajectoryPlacements）と「軌跡をどう計算するか」
  // （computeTransitionPaths）を分離しており、"next"/"previous"どちらのモードでも
  // 軌跡の計算・描画コード自体は同じものを再利用する。
  // OFFの場合、または参照先の構成が存在しない場合（最後の構成での"next"、
  // 最初の構成での"previous"）は空配列にする。
  const transitionPaths = useMemo(() => {
    if (!showTrajectory) return [];
    const ref = getTrajectoryPlacements({ slides, currentSlideIndex, mode: trajectoryMode });
    if (!ref) return [];
    // 曲線に設定されている出演者がいれば、その経路設定（work.transitionPathConfig、
    // キーは移動元スライドのid）をそのまま computeTransitionPaths へ渡す。
    // 「構成3→構成4」の曲線は、構成3で「次に」を見ても構成4で「前に」を見ても
    // ref.fromSlideId は常に「構成3のid」になるため、同じ1つのデータをそのまま参照でき、
    // 経路データを二重に保存する必要がない。
    const pathConfig = (effectiveTransitionPathConfig && effectiveTransitionPathConfig[ref.fromSlideId]) || null;
    return computeTransitionPaths(ref.fromPlacements, ref.toPlacements, pathConfig);
  }, [showTrajectory, trajectoryMode, slides, currentSlideIndex, effectiveTransitionPathConfig]);

  // ------------------------------------------------------------
  // 構成間アニメーションv3：1通過点だけの曲線移動（経路の編集）
  // v3.1：複数選択でも直線／曲線の一括切替・waypointのグループ移動に対応
  // ------------------------------------------------------------
  // 編集対象の遷移（fromSlideId/toSlideId/from・toのplacements）は、選択人数に関係なく
  // 現在表示中の軌跡モード（trajectoryMode＝「次に」／「前に」）だけで決まる。
  // 「構成3→構成4」の編集は、構成3で「次に」を見ても構成4で「前に」を見ても
  // 必ず同じ fromSlideId（＝構成3のid）を指すため、work.transitionPathsを
  // 二重に保存することはない。
  const activeTransitionRef = useMemo(() => {
    return getTrajectoryPlacements({ slides, currentSlideIndex, mode: trajectoryMode });
  }, [slides, currentSlideIndex, trajectoryMode]);

  // 選択中の出演者のうち、実際に編集対象にできる出演者（＝開始・終了どちらの構成にも
  // placementが存在し、「移動」を定義できる出演者）だけを抽出する。
  // 1人選択時はこの配列の長さは高々1になり、既存の単独編集と同じ挙動になる。
  const editablePerformerIds = useMemo(() => {
    if (!activeTransitionRef) return [];
    return selectedIds.filter(
      (id) => activeTransitionRef.fromPlacements[id] && activeTransitionRef.toPlacements[id]
    );
  }, [activeTransitionRef, selectedIds]);

  // 選択中（編集可能分）の経路種別のまとめ。
  //   全員 "linear" → "linear" / 全員 "curve" → "curve" / 混在 → "mixed" / 対象なし → null
  // UI側は"mixed"のとき[直線][曲線]どちらもactiveにしない。
  // スマート経路（自動curve）が表示中の出演者も"curve"として扱う（ボタンの状態表示を
  // 実際に見えている経路と一致させるため、effectiveTransitionPathConfigを参照する）。
  const selectedPathTypeSummary = useMemo(() => {
    if (!activeTransitionRef || editablePerformerIds.length === 0) return null;
    const fromId = activeTransitionRef.fromSlideId;
    const types = editablePerformerIds.map(
      (id) => getPerformerTransitionPath(effectiveTransitionPathConfig, fromId, id).type
    );
    if (types.every((t) => t === "linear")) return "linear";
    if (types.every((t) => t === "curve")) return "curve";
    return "mixed";
  }, [activeTransitionRef, editablePerformerIds, effectiveTransitionPathConfig]);

  // 選択中（編集可能分）の経路が、1件も作品データ（work.transitionPaths）へ永続化されて
  // いない「純粋なスマート経路の自動提案」だけで構成されているかどうか。UIの
  // 「自動経路」badge表示にのみ使う判定で、実際の経路データや補間処理には一切影響しない（14章）。
  const isSelectionPureAutoPath = useMemo(() => {
    if (!activeTransitionRef || editablePerformerIds.length === 0) return false;
    const fromId = activeTransitionRef.fromSlideId;
    const rawForSlide = transitionPathConfig && transitionPathConfig[fromId];
    return editablePerformerIds.every((id) => {
      const raw = rawForSlide && rawForSlide[id];
      if (raw) return false; // 永続化済み（手動）データがあれば自動扱いにしない
      const eff = getPerformerTransitionPath(effectiveTransitionPathConfig, fromId, id);
      return eff.type === "curve";
    });
  }, [activeTransitionRef, editablePerformerIds, transitionPathConfig, effectiveTransitionPathConfig]);

  // 「直線」⇔「曲線」の一括切替。選択人数に関わらず1回の操作＝1件のUndo履歴（commitWork）。
  // 再生中は変更できない（誤操作防止・再生途中の経路変化を防ぐ）。
  //   ・"curve"へ：既に手動保存済みのcurveならそのまま維持（初期化しない）。まだ未保存の
  //     出演者は、現在スマート経路が自動表示中ならその位置をそのまま手動確定として保存し
  //     （16章：スマート経路用waypointへ必ず戻す必要はない＝いま見えている位置を維持する）、
  //     対象外ならcomputeInitialWaypointで“独立した”waypointを新規生成する。
  //     どちらの場合も、ボタンでの明示的な選択のため source:"manual" を付ける（12章・17章）。
  //   ・"linear"へ：スマート経路の対象area組み合わせのままだと、何もしないと次回描画時に
  //     effectiveTransitionPathConfigが自動curveを再提案してしまうため、その場合だけ
  //     明示的に {type:"linear", source:"manual"} を保存して自動再提案を止める（15章）。
  //     対象外の組み合わせは、従来通りエントリを削除するだけでよい（元々自動提案され得ないため）。
  const setSelectedPathMode = useCallback(
    (mode) => {
      if (isTransitionActive) return;
      if (!activeTransitionRef || editablePerformerIds.length === 0) return;
      const fromId = activeTransitionRef.fromSlideId;
      commitWork((prev) => {
        const forSlide = prev.transitionPaths[fromId] || {};
        const nextForSlide = { ...forSlide };
        let changed = false;
        editablePerformerIds.forEach((id) => {
          const fromPos = activeTransitionRef.fromPlacements[id];
          const toPos = activeTransitionRef.toPlacements[id];
          if (mode === "curve") {
            const existing = nextForSlide[id];
            if (existing && existing.type === "curve") return; // 既存のwaypointを維持（初期化しない）
            const smartWaypoint = computeSmartWaitingAreaWaypoint({ fromPlacement: fromPos, toPlacement: toPos, stage, zones });
            const waypoint = smartWaypoint || computeInitialWaypoint(fromPos, toPos); // 出演者ごとに独立して計算する
            nextForSlide[id] = { type: "curve", waypoint, source: "manual" };
            changed = true;
          } else {
            const isSmartPair = isSmartWaitingAreaTransition(fromPos && fromPos.area, toPos && toPos.area);
            if (!nextForSlide[id] && !isSmartPair) return; // 元々直線（スマート対象でもない）なら変更なし
            if (isSmartPair) {
              // スマート経路の対象area組み合わせのままエントリを消すだけだと、次回描画時に
              // 自動curveへ戻ってしまうため、明示的に「手動で直線」を記録する（15章）
              nextForSlide[id] = { type: "linear", source: "manual" };
            } else {
              delete nextForSlide[id];
            }
            changed = true;
          }
        });
        if (!changed) return prev;
        const nextTransitionPaths = { ...prev.transitionPaths };
        if (Object.keys(nextForSlide).length === 0) {
          delete nextTransitionPaths[fromId];
        } else {
          nextTransitionPaths[fromId] = nextForSlide;
        }
        return { ...prev, transitionPaths: nextTransitionPaths };
      });
    },
    [commitWork, activeTransitionRef, editablePerformerIds, isTransitionActive, stage, zones]
  );

  // 通過点（waypoint）の編集ハンドル。「移動軌跡を表示」がONの時だけ、軌跡レイヤーの上に
  // 表示する（軌跡が非表示の状態でハンドルだけ単独で浮いて見えるのを避けるため）。
  //   ・selectedIds.length === 1 → mode:"single"（既存の個別◇編集をそのまま維持）
  //   ・selectedIds.length >= 2  → mode:"group" （選択中のcurve出演者だけを対象にした
  //     1個のグループハンドルを、それらのwaypointの平均位置に表示する。linear出演者は
  //     waypointを持たないため対象に含めない＝「曲線」を押して初めてグループ対象になる）
  // どちらの場合も members にドラッグ対象の {performerId, x, y} 一覧を持たせておき、
  // ドラッグ処理（TopView側）で「各自の現在位置＋同じdelta」を計算できるようにする。
  // スマート経路の自動curveも、手動curveと同じくハンドルをドラッグして編集できるように
  // effectiveTransitionPathConfig（手動設定＋自動提案の実効値）を参照する（17章）。
  // ドラッグで実際に動かした瞬間にupdateWaypointLive側でmanualとして永続化される。
  const waypointHandle = useMemo(() => {
    if (!showTrajectory) return null;
    if (!activeTransitionRef || editablePerformerIds.length === 0) return null;
    const fromId = activeTransitionRef.fromSlideId;
    const curveMembers = editablePerformerIds
      .map((id) => ({ id, cfg: getPerformerTransitionPath(effectiveTransitionPathConfig, fromId, id) }))
      .filter((m) => m.cfg.type === "curve" && m.cfg.waypoint)
      .map((m) => ({ performerId: m.id, x: m.cfg.waypoint.x, y: m.cfg.waypoint.y }));
    if (curveMembers.length === 0) return null;
    const mode = selectedIds.length === 1 ? "single" : "group";
    const avgX = curveMembers.reduce((sum, m) => sum + m.x, 0) / curveMembers.length;
    const avgY = curveMembers.reduce((sum, m) => sum + m.y, 0) / curveMembers.length;
    return {
      mode,
      fromSlideId: fromId,
      handleX: mode === "single" ? curveMembers[0].x : avgX,
      handleY: mode === "single" ? curveMembers[0].y : avgY,
      members: curveMembers,
    };
  }, [showTrajectory, activeTransitionRef, editablePerformerIds, effectiveTransitionPathConfig, selectedIds.length]);

  // 通過点のドラッグ中のライブ更新（履歴を増やさない）。updatesは
  // [{performerId, x, y}, ...] の配列で、単独編集（要素1件）・グループ編集（要素複数件）の
  // どちらも同じ関数・同じ1回のupdateWorkLive呼び出しでまとめて（アトミックに）反映する。
  // ドラッグ開始/終了自体は出演者ドラッグと同じ beginWorkBatch/endWorkBatch
  // （handleDragStart/handleDragEnd）をそのまま再利用し、1回のドラッグ＝1件のUndo履歴にまとめる。
  //
  // 待機エリア間スマート経路v1：ドラッグ対象（waypointHandle.members）は
  // effectiveTransitionPathConfig（手動＋自動提案）から作られているため、まだ
  // work.transitionPathsに永続化されていない「スマート経路の自動提案」をドラッグする
  // ケースがあり得る。その場合は既存エントリを更新するのではなく、ドラッグ後の座標で
  // 新規にmanualエントリを作成する（＝ドラッグした時点でauto→manualへ切り替わる。17章）。
  const updateWaypointLive = useCallback(
    (fromSlideId, updates) => {
      if (isTransitionActive) return; // 再生中は通過点を変更できない
      if (!updates || updates.length === 0) return;
      updateWorkLive((prev) => {
        const forSlide = prev.transitionPaths[fromSlideId] || {};
        const nextForSlide = { ...forSlide };
        let changed = false;
        updates.forEach(({ performerId, x, y }) => {
          const existing = nextForSlide[performerId];
          if (existing && existing.type === "curve") {
            // 既に永続化されている（手動・自動を問わず）curveエントリ → 座標を更新しつつmanual化する
            nextForSlide[performerId] = { ...existing, waypoint: { x, y }, source: "manual" };
            changed = true;
            return;
          }
          // 永続化されたエントリがまだ無い場合：現在表示中の実効設定（effectiveTransitionPathConfig）
          // でcurveとして扱われている出演者（＝スマート経路の自動提案）だけ、ドラッグを機に
          // 新規のmanualエントリとして保存する。曲線設定が全く無い出演者は何もしない（安全策）。
          const eff = getPerformerTransitionPath(effectiveTransitionPathConfig, fromSlideId, performerId);
          if (eff.type !== "curve") return;
          nextForSlide[performerId] = { type: "curve", waypoint: { x, y }, source: "manual" };
          changed = true;
        });
        if (!changed) return prev;
        return { ...prev, transitionPaths: { ...prev.transitionPaths, [fromSlideId]: nextForSlide } };
      });
    },
    [updateWorkLive, isTransitionActive, effectiveTransitionPathConfig]
  );

  // 「＋ 新しい構成を追加」：現在選択中の構成の配置をコピーした新しい構成を、
  // 必ずslides配列の末尾へ追加してそこへ切り替える（元は構成の直後に挿入していたが、
  // 「複製」ボタンを廃止しこの1つに役割を統合したため、常に末尾へ追加する仕様に変更した）。
  // 真っ白な構成は作らず、名前は「構成 N」の形で自動採番する（nextAutoSlideNameで重複しないNを決める）。
  // 構成の作成自体はUndo対象とする（commitWorkを使う）。
  const addNewSlide = useCallback(() => {
    if (isTransitionActive) return; // 再生中は構成の追加・削除・並べ替えを無効化
    commitWork((prev) => {
      const src = prev.slides[prev.currentSlideIndex];
      const clonedPlacements = Object.fromEntries(
        Object.entries(src.placements).map(([id, pos]) => [id, { ...pos }])
      );
      const newSlide = {
        id: makeId("slide"),
        name: nextAutoSlideName(prev.slides),
        placements: clonedPlacements,
        keepCounts: DEFAULT_KEEP_COUNTS, // キープは構成そのものの属性なので、新規構成には常に既定値から始める
        musicAnchor: null, // 4章：前構成のアンカーは自動コピーしない。必要な構成だけユーザーが個別に設定する
      };
      const nextSlides = [...prev.slides, newSlide];
      // 「直前の構成→新しい構成」の遷移はDEFAULT_TRANSITION_COUNTS（既定値）から開始する。
      // reconcileTransitionCountsは「変化していない隣接ペア」だけを引き継ぐため、
      // 新しく生まれたこのペアには何も書き込まれず、参照時に既定値へ自動フォールバックする。
      const nextTransitionCounts = reconcileTransitionCounts(prev.transitionCounts, prev.slides, nextSlides);
      // 曲線設定（transitionPaths）も、transitionCountsと全く同じ考え方で
      // 「隣接ペアが変化していない遷移」だけを引き継ぐ。新しく生まれたこのペアには
      // 何も書き込まれず、参照時に既定値（直線）へ自動フォールバックする。
      const nextTransitionPaths = reconcileTransitionPaths(prev.transitionPaths, prev.slides, nextSlides);
      return {
        ...prev,
        slides: nextSlides,
        currentSlideIndex: nextSlides.length - 1,
        transitionCounts: nextTransitionCounts,
        transitionPaths: nextTransitionPaths,
      };
    });
  }, [commitWork, isTransitionActive]);

  // 構成削除の確認ダイアログ表示状態（構成一覧v2・第1段階）。null=閉じている、
  // 数値=その削除確認対象のslide index。従来は「常にcurrentSlideIndexを削除する」前提の
  // boolean（slideDeleteConfirmOpen）だったが、構成一覧からは「今表示していない構成」も
  // 削除できる必要があるため、対象indexを持つ形へ一般化した（ConfirmDeleteSlideModal自体・
  // window.confirm()を使わない方針は変更しない＝21章）。
  const [slideDeleteTargetIndex, setSlideDeleteTargetIndex] = useState(null);

  // 指定したindexの構成を1つ削除する（構成一覧v2・第1段階でcurrentSlideIndex以外も
  // 削除できるよう一般化）。出演者本体（performers）や他の構成のplacementsは一切変更しない。
  // 構成が1つしかない場合は何もしない（呼び出し側でも削除ボタンをdisabledにして二重に防ぐ）。
  // indexを省略した場合はcurrentSlideIndexを削除する（従来のdeleteCurrentSlide()と完全に
  //同じ挙動を維持＝下部操作バーの削除ボタン・キーボードショートカットからの呼び出しは無変更）。
  const deleteSlideAt = useCallback(
    (indexArg) => {
      if (isTransitionActive) return; // 再生中は構成の追加・削除・並べ替えを無効化
      commitWork((prev) => {
        if (prev.slides.length <= 1) return prev;
        const idx = typeof indexArg === "number" ? indexArg : prev.currentSlideIndex;
        if (idx < 0 || idx >= prev.slides.length) return prev;
        const nextSlides = prev.slides.filter((_, i) => i !== idx);
        // currentSlideIndexの追従：
        // ・削除したのがまさに現在表示中の構成なら、削除した位置の直前を選択する
        //   （先頭を削除した場合は新しい先頭）＝従来のdeleteCurrentSlide()と完全に同じ式。
        // ・現在構成より前を削除した場合は、詰まった分だけ1つ前へ補正する。
        // ・現在構成より後ろを削除した場合は、現在構成の位置自体は変わらない。
        let nextIndex;
        if (idx === prev.currentSlideIndex) {
          nextIndex = clamp(idx > 0 ? idx - 1 : 0, 0, nextSlides.length - 1);
        } else if (idx < prev.currentSlideIndex) {
          nextIndex = clamp(prev.currentSlideIndex - 1, 0, nextSlides.length - 1);
        } else {
          nextIndex = clamp(prev.currentSlideIndex, 0, nextSlides.length - 1);
        }
        // 削除された構成自身の遷移、および直前の構成の「次への遷移」は隣接関係が変わるため、
        // reconcileTransitionCountsによって自動的に既定値（DEFAULT_TRANSITION_COUNTS）へフォールバックする。
        const nextTransitionCounts = reconcileTransitionCounts(prev.transitionCounts, prev.slides, nextSlides);
        const nextTransitionPaths = reconcileTransitionPaths(prev.transitionPaths, prev.slides, nextSlides);
        return {
          ...prev,
          slides: nextSlides,
          currentSlideIndex: nextIndex,
          transitionCounts: nextTransitionCounts,
          transitionPaths: nextTransitionPaths,
        };
      });
    },
    [commitWork, isTransitionActive]
  );

  // 一括削除 v1・7章：複数構成削除後のcurrentSlideIndex解決。単体削除（deleteSlideAt、上記）の
  // 「indexを1つずらす」方式は複数件には素直に拡張できないため、削除前の現在表示中slideの
  // 「id」を基準に追跡する（indexではなくidで追う）。
  //   ・現在構成が削除対象でない場合：nextSlides内で同じidを探し、その新しいindexを使う。
  //   ・現在構成も削除対象の場合：削除前のcurrentSlideIndexより前にある、削除対象ではない
  //     slideのうち最も近いもの（＝直前の生き残り）を選ぶ。無ければ先頭（index 0）。
  function resolveCurrentSlideIndexAfterBulkDelete(prevSlides, prevCurrentSlideIndex, nextSlides, deletedIdSet) {
    const currentSlide = prevSlides[prevCurrentSlideIndex];
    const currentSlideId = currentSlide ? currentSlide.id : null;
    if (currentSlideId && !deletedIdSet.has(currentSlideId)) {
      const idx = nextSlides.findIndex((s) => s.id === currentSlideId);
      if (idx !== -1) return idx;
    }
    // 現在構成自体が削除対象（または見つからない）：削除前のcurrentSlideIndexより前にある
    // 生き残りslideのうち、最も近いものを探す。
    for (let i = prevCurrentSlideIndex - 1; i >= 0; i--) {
      const candidateId = prevSlides[i].id;
      if (!deletedIdSet.has(candidateId)) {
        const idx = nextSlides.findIndex((s) => s.id === candidateId);
        if (idx !== -1) return idx;
      }
    }
    return 0;
  }

  // 一括削除 v1：構成一覧の複数選択モードから、選択された複数slideを1回のcommitWorkで
  // まとめて削除する。deleteSlideAt()を件数分ループしない（Undo1回=削除全件という単位を
  // 守るため）。transitionCounts/transitionPathsは既存のreconcileTransitionCounts・
  // reconcileTransitionPathsへそのまま任せ、削除によって新しく隣接した構成ペアへ
  // 旧transition/経路を勝手に引き継がない（既存のdeleteSlideAtと同じreconcile思想）。
  // 最低1構成は必ず残す（nextSlides.length < 1になる場合は削除せず、prevをそのまま返す）。
  const deleteSlidesByIds = useCallback(
    (ids) => {
      if (isTransitionActive) return;
      if (!Array.isArray(ids) || ids.length === 0) return;
      commitWork((prev) => {
        const idSet = new Set(ids);
        const nextSlides = prev.slides.filter((slide) => !idSet.has(slide.id));
        if (nextSlides.length < 1) return prev; // 最低1構成ルール（保険。UI側のdisabled判定と二重の安全策）
        const nextCurrentSlideIndex = resolveCurrentSlideIndexAfterBulkDelete(prev.slides, prev.currentSlideIndex, nextSlides, idSet);
        const nextTransitionCounts = reconcileTransitionCounts(prev.transitionCounts, prev.slides, nextSlides);
        const nextTransitionPaths = reconcileTransitionPaths(prev.transitionPaths, prev.slides, nextSlides);
        return {
          ...prev,
          slides: nextSlides,
          currentSlideIndex: nextCurrentSlideIndex,
          transitionCounts: nextTransitionCounts,
          transitionPaths: nextTransitionPaths,
        };
      });
    },
    [commitWork, isTransitionActive]
  );


  // 構成一覧v2・第1段階・1章：指定したindexの構成を、その直後へ複製する。
  // 構成一覧v2・第2段階①で、実際の複製処理はinsertSlideCopyAfter()（共通pure関数）へ
  // 切り出した。deepCopyPlainObject・新規id発行・reconcileTransitionCounts/
  // reconcileTransitionPathsという中身は一切変わっていない（21章：既存の複製を壊さない
  // リファクタリング）。currentSlideIndexは、複製元より後ろにあった場合だけ+1して追従させ、
  // それ以外は変更しない（構成一覧を操作している間、メイン編集画面が意図せず別の構成へ
  // 切り替わらないようにするため）。
  const duplicateSlideAt = useCallback(
    (index) => {
      if (isTransitionActive) return;
      commitWork((prev) => {
        if (index < 0 || index >= prev.slides.length) return prev;
        const src = prev.slides[index];
        const { nextSlides, nextTransitionCounts, nextTransitionPaths } = insertSlideCopyAfter(
          prev.slides,
          prev.transitionCounts,
          prev.transitionPaths,
          src,
          index
        );
        const nextCurrentIndex = prev.currentSlideIndex > index ? prev.currentSlideIndex + 1 : prev.currentSlideIndex;
        return {
          ...prev,
          slides: nextSlides,
          currentSlideIndex: nextCurrentIndex,
          transitionCounts: nextTransitionCounts,
          transitionPaths: nextTransitionPaths,
        };
      });
    },
    [isTransitionActive, commitWork]
  );

  // キーボード（Delete/Backspace）から構成削除を要求する処理。既存の削除ボタンと全く同じ
  // 確認モーダル（確定時にdeleteSlideAt()を呼ぶ既存JSXをそのまま使う＝21章）を再利用する。
  // 削除ボタン自身はdisabled属性で「最後の1構成」を防いでいるが（canDeleteSlide=slides.length>1）、
  // キーボードにはdisabled相当が無いため、ここで同じ条件を明示的にチェックする（22章：既存仕様を維持）。
  const requestDeleteCurrentSlideByKeyboard = useCallback(() => {
    if (isTransitionActive) return; // 28〜29章：再生中・一時停止中は無効
    if (slides.length <= 1) return; // 22章：最後の1構成は削除不可
    setSlideDeleteTargetIndex(currentSlideIndex);
  }, [isTransitionActive, slides.length, currentSlideIndex]);

  // ==============================================================
  // Keyboard Editing v1 PART A：構成コピー / 貼り付け
  // ==============================================================
  // アプリ内部だけの一時的なclipboard。navigator.clipboard／system clipboardへは一切書き込まない
  // （2章）。Undo/Redo対象外のrefで保持する（Copy自体はwork＝作品データを一切変更しないため）。
  // Project間コピー v1・1章：保持する形を { slide, sourceProjectId, sourcePerformersSnapshot } へ
  // 拡張した（従来は複製したslideオブジェクトそのものを直接保持していた）。sourceProjectIdは
  // 貼り付け時に「同一Project内か、Project間か」を判定するためだけに使う。同一Project内の
  // 貼り付け（従来からの主要ケース）はこの追加情報を一切参照しないため、挙動は変わらない。
  // 複数構成一括コピー v1・STEP2：構成一覧の複数選択から一括コピーした場合は、
  // { slides: [...], sourceProjectId, sourcePerformersSnapshot, sourceInternalTransitionCounts,
  //   sourceInternalTransitionPaths } という別の形（単数形slideではなく複数形slidesキー）で
  // 同じrefへ保持する。単体Ctrl+C（slideキー）と複数選択コピー（slidesキー）はどちらか一方だけが
  // 常に入る（同じrefを共有し、直近のコピー操作で上書きされる）。貼り付け側はキーの有無で
  // 単体/複数を判定するため、単体用の既存コード（下記copyCurrentSlide・pasteCopiedSlideの
  // slide分岐）は変更していない。
  const copiedSlideRef = useRef(null);

  // 複数構成一括コピー v1・STEP1：copiedSlideRefが直近で「複数選択からの一括コピー」を
  // 保持しているかどうかを示す、UI表示専用のreactive state（refはそれ自体では再描画を
  // トリガーしないため、「この後に貼り付け」メニュー項目のdisabled切り替えに使うためだけに
  // このミラーstateを持つ）。work/Undo対象外。copySelectedSlides()でtrueにし、単体Ctrl+C
  // （copyCurrentSlide）が呼ばれてclipboardが単体へ上書きされた瞬間にfalseへ戻す。
  // Project切替時には触れない（複数clipboardもProject切替を生き延びる仕様のため）。
  const [hasBulkClipboard, setHasBulkClipboard] = useState(false);

  // 現在選択中の構成（slides[currentSlideIndex]）を1枚、内部clipboardへdeep copyする（3章）。
  // ・出演者が1人以上選択されている場合は何もしない（14章：将来の出演者コピーのため予約）。
  // ・placements・keepCounts・nameを含むslideオブジェクト全体をdeep copyする（4章）。
  //   transitionCounts/transitionPaths（構成「間」のデータ）はslideオブジェクトに含まれないため
  //   自然に除外され、performers本体（project全体のデータ）もslideには含まれないため
  //   同様に自然に除外される（5〜6章）。
  // ・再生中・一時停止中は作品データを変更しない既存方針に合わせ、誤操作防止のため無効化する（28〜29章）。
  //   ※Copy自体はworkを変更しないが、「構成アニメーションのセッション中は構成編集系の操作を
  //     一切受け付けない」という既存の統一方針に合わせておく。
  // Project間コピー v1・1章：sourceProjectId（コピー時点のactiveProjectId）と、出演者対応付けに
  // 必要な最小限のスナップショット（id/number/name。コピー時点のperformersから作る）を併せて
  // 保持する。同一Project内で貼り付ける限り、この2つの追加情報は一切参照されない。
  const copyCurrentSlide = useCallback(() => {
    if (isTransitionActive) return;
    if (selectedIds.length > 0) return;
    const slide = slides[currentSlideIndex];
    if (!slide) return;
    copiedSlideRef.current = {
      slide: deepCopyPlainObject(slide),
      sourceProjectId: workspace.activeProjectId,
      sourcePerformersSnapshot: performers.map((p) => ({ id: p.id, number: p.number, name: getPerformerName(p) })),
    };
    setHasBulkClipboard(false); // 単体コピーでclipboardが上書きされたため、複数clipboardは無くなった
  }, [isTransitionActive, selectedIds, slides, currentSlideIndex, workspace.activeProjectId, performers]);

  // 複数構成一括コピー v1・STEP1：構成一覧の複数選択モードで選択されたslide.id配列。
  // 既存のExport Center用selectedExportSlideIds（App()側でlift済み）と全く同じ設計パターンを
  // 踏襲する。選択モードON/OFF自体はSlideListModal内のローカルstateとし、実際に選択された
  // id配列だけをこちらへ持たせる（7〜8章の役割分担）。work/Undo対象外。
  const [selectedCopySlideIds, setSelectedCopySlideIds] = useState([]);
  const toggleCopySlideSelection = useCallback((slideId) => {
    setSelectedCopySlideIds((prev) => (prev.includes(slideId) ? prev.filter((id) => id !== slideId) : [...prev, slideId]));
  }, []);
  const selectAllCopySlides = useCallback(() => {
    setSelectedCopySlideIds(slides.map((s) => s.id));
  }, [slides]);
  const clearCopySlideSelection = useCallback(() => {
    setSelectedCopySlideIds([]);
  }, []);

  // 複数構成一括コピー v1・STEP1・2：構成一覧の選択モードで選択された構成群を、元Project内の
  // 構成順（クリック順ではない）を維持したまま一括でclipboardへ保存する。
  // slides.filter()が元配列の順序をそのまま保つ性質を利用し、二重の並べ替えロジックを作らない
  // （15章）。内部transition（コピー元で直接隣接していた選択slide同士のtransitionCounts/
  // transitionPaths）は、findAdjacentSelectedSlidePairsで判定した対象だけを、旧fromSlideIdを
  // キーにした小さなmapとして併せて保持する（bulk貼り付け時にinsertSlidesCopyAfterが
  // oldId→newIdへ移植するために使う）。それ以外（外側との接続）は保持しない＝貼り付け先の
  // reconcileルールへ委ねる（16章）。
  const copySelectedSlides = useCallback(() => {
    if (isTransitionActive) return;
    if (selectedCopySlideIds.length === 0) return;
    const selectedIdSet = new Set(selectedCopySlideIds);
    const orderedSelectedSlides = slides.filter((s) => selectedIdSet.has(s.id));
    if (orderedSelectedSlides.length === 0) return;
    const adjacentPairs = findAdjacentSelectedSlidePairs(slides, selectedIdSet);
    const sourceInternalTransitionCounts = {};
    const sourceInternalTransitionPaths = {};
    // 注意：ここでの「transitionPaths」という名前はwork.transitionPaths（fromSlideIdをキーに
    // 持つオブジェクト）を指す必要があるが、App()内には同名の別変数（移動軌跡表示専用の
    // 計算結果、配列）が存在するため、混同を避けて必ずwork.transitionPaths（＝
    // transitionPathConfig。5881行の既存コメント通りの命名衝突対策）を参照する。
    adjacentPairs.forEach(({ fromId }) => {
      if (Object.prototype.hasOwnProperty.call(transitionCounts || {}, fromId)) {
        sourceInternalTransitionCounts[fromId] = transitionCounts[fromId];
      }
      if (transitionPathConfig && Object.prototype.hasOwnProperty.call(transitionPathConfig, fromId)) {
        sourceInternalTransitionPaths[fromId] = deepCopyPlainObject(transitionPathConfig[fromId]);
      }
    });
    copiedSlideRef.current = {
      slides: orderedSelectedSlides.map((s) => deepCopyPlainObject(s)),
      sourceProjectId: workspace.activeProjectId,
      sourcePerformersSnapshot: performers.map((p) => ({ id: p.id, number: p.number, name: getPerformerName(p) })),
      sourceInternalTransitionCounts,
      sourceInternalTransitionPaths,
    };
    setHasBulkClipboard(true);
    setSelectedCopySlideIds([]); // コピー実行後は選択状態をクリアする（STEP1確定仕様）
  }, [isTransitionActive, selectedCopySlideIds, slides, transitionCounts, transitionPathConfig, workspace.activeProjectId, performers]);

  // 一括削除 v1・12章：確認モーダルを開いた後にselectedCopySlideIdsが変化しても、確認対象が
  // 意図せず変わらないよう、削除対象idはボタンを押した時点でsnapshotとして持つ（selectedCopySlideIds
  // への参照ではなく、独立した配列のコピー）。work/Undo対象外のUI専用一時state。
  const [pendingBulkSlideDeleteIds, setPendingBulkSlideDeleteIds] = useState(null);

  // 選択モードの「削除」ボタンから呼ばれる。この時点ではまだ削除せず、確認モーダルを開くだけ。
  const requestBulkSlideDelete = useCallback(() => {
    if (isTransitionActive) return;
    if (selectedCopySlideIds.length === 0) return;
    if (slides.length - selectedCopySlideIds.length < 1) return; // 最低1構成ルール（保険）
    setPendingBulkSlideDeleteIds([...selectedCopySlideIds]);
  }, [isTransitionActive, selectedCopySlideIds, slides.length]);

  // 確認モーダルの「削除する」。実際の削除（1回のcommitWork）を実行し、確認state・選択状態を
  // クリアする。選択モード自体（selectionModeActive）はSlideListModal内のローカルstateのため、
  // ここでは直接触れられない（既存の「コピー後に選択モードを終了する」仕組みと同じパターンで、
  // SlideListModal側がこの関数の呼び出し後に自分でselectionModeActiveをfalseへ戻す）。
  const confirmBulkSlideDelete = useCallback(() => {
    if (pendingBulkSlideDeleteIds) {
      deleteSlidesByIds(pendingBulkSlideDeleteIds);
    }
    setPendingBulkSlideDeleteIds(null);
    setSelectedCopySlideIds([]);
  }, [pendingBulkSlideDeleteIds, deleteSlidesByIds]);

  // 確認モーダルの「キャンセル」/背景クリック。work変更なし・Undo履歴追加なし・
  // selectedCopySlideIdsは維持する（そのまま「コピー」へ切り替えられるようにするため＝14章）。
  const cancelBulkSlideDelete = useCallback(() => {
    setPendingBulkSlideDeleteIds(null);
  }, []);

  // Project間コピー v1・4・8章：出演者対応表（number+nameで一致した分だけ）を使って
  // placements/musicAnchorを変換したslideを、insertSlideCopyAfter()へ渡して貼り付け先Projectへ
  // 挿入する。挿入ロジック自体（新規slide.id発行・transitionCounts/transitionPathsのreconcile）は
  // 同一Project内の貼り付けと完全に共通で、insertSlideCopyAfter()をそのまま再利用する（実装方針：
  // 既存の複製処理を二重実装しない）。1回のcommitWorkで完結させ、Paste＝Undo1件を維持する（14章）。
  // ※単体（1枚）専用。複数選択からの一括貼り付けは下のinsertBulkPastedSlidesIntoWordを使う。
  const insertCrossProjectPastedSlide = useCallback(
    (sourceSlide, performerIdMap) => {
      const translatedSlide = translateSlideForCrossProjectPaste(sourceSlide, performerIdMap);
      commitWork((prev) => {
        const insertAt = prev.currentSlideIndex;
        const { nextSlides, nextTransitionCounts, nextTransitionPaths, newSlideId } = insertSlideCopyAfter(
          prev.slides,
          prev.transitionCounts,
          prev.transitionPaths,
          translatedSlide,
          insertAt
        );
        const nextCurrentIndex = nextSlides.findIndex((s) => s.id === newSlideId);
        return {
          ...prev,
          slides: nextSlides,
          currentSlideIndex: nextCurrentIndex === -1 ? prev.currentSlideIndex : nextCurrentIndex,
          transitionCounts: nextTransitionCounts,
          transitionPaths: nextTransitionPaths,
        };
      });
    },
    [commitWork]
  );

  // 複数構成一括コピー v1・STEP4・STEP12：insertSlidesCopyAfter（複数slide用のbulk挿入pure
  // helper）を使って、1回のcommitWorkで複数slideをまとめて挿入する。afterIndexResolverは
  // 「挿入位置をprev（コミット直前の最新work）から都度決める関数」で、Ctrl+Vは常に
  // prev.currentSlideIndex、構成一覧の「この後に貼り付け」は明示的に指定されたindexを返す
  // （呼び出し側で使い分ける＝STEP12）。performerIdMapがnullなら同一Project内一括コピー、
  // Mapが渡されればProject間一括コピー（insertSlidesCopyAfter内部でplacements/musicAnchor/
  // transitionPaths内performerIdを変換する）。貼り付け後は挿入した先頭slideをcurrentSlideIndex
  // として選択する（単体貼り付けと同じ考え方）。
  const insertBulkPastedSlidesIntoWork = useCallback(
    (sourceSlides, sourceInternalTransitionCounts, sourceInternalTransitionPaths, performerIdMap, afterIndexResolver) => {
      commitWork((prev) => {
        const afterIndex = typeof afterIndexResolver === "function" ? afterIndexResolver(prev) : prev.currentSlideIndex;
        if (afterIndex < -1 || afterIndex >= prev.slides.length) return prev; // 保険（対象indexが既に無い等）
        const { nextSlides, nextTransitionCounts, nextTransitionPaths, newSlideIds } = insertSlidesCopyAfter(
          prev.slides,
          prev.transitionCounts,
          prev.transitionPaths,
          sourceSlides,
          sourceInternalTransitionCounts || {},
          sourceInternalTransitionPaths || {},
          performerIdMap,
          afterIndex
        );
        const nextCurrentIndex = newSlideIds.length > 0 ? nextSlides.findIndex((s) => s.id === newSlideIds[0]) : -1;
        return {
          ...prev,
          slides: nextSlides,
          currentSlideIndex: nextCurrentIndex === -1 ? prev.currentSlideIndex : nextCurrentIndex,
          transitionCounts: nextTransitionCounts,
          transitionPaths: nextTransitionPaths,
        };
      });
    },
    [commitWork]
  );

  // 複数構成一括コピー v1・STEP8：copiedSlideRefが複数選択からの一括clipboard（slidesキー）を
  // 保持している場合の、貼り付け実行の共通入口。Ctrl+V（pasteCopiedSlide）・構成一覧の
  // 「この後に貼り付け」（pasteSlideAfterIndex）の両方から、afterIndexResolverだけを変えて
  // 呼び出す（同じbulk paste処理を重複実装しない＝STEP12「複数Ctrl+Vだけ別の簡易実装を作らない」）。
  // 同一Project内はperformerIdMap=nullでそのまま一括挿入。Project間は、複数slide版の出演者
  // 対応付け（buildCrossProjectPerformerMappingForSlides）を1回だけ行い、未一致がいれば
  // Paste実行前の確認待ちstate（pendingCrossProjectPaste）へ積んで、実際の挿入は
  // confirmCrossProjectPasteへ委ねる（単体Project間コピーと同じ考え方・同じstateを共用する）。
  const executeBulkPaste = useCallback(
    (afterIndexResolver) => {
      const clip = copiedSlideRef.current;
      if (!clip || !Array.isArray(clip.slides) || clip.slides.length === 0) return;
      if (clip.sourceProjectId && clip.sourceProjectId !== workspace.activeProjectId) {
        const { matchedMap, unmatchedSourcePerformers } = buildCrossProjectPerformerMappingForSlides(
          clip.slides,
          clip.sourcePerformersSnapshot,
          performers
        );
        if (unmatchedSourcePerformers.length > 0) {
          setPendingCrossProjectPaste({
            sourceProjectId: clip.sourceProjectId,
            targetProjectId: workspace.activeProjectId,
            sourceSlides: clip.slides,
            sourceInternalTransitionCounts: clip.sourceInternalTransitionCounts || {},
            sourceInternalTransitionPaths: clip.sourceInternalTransitionPaths || {},
            performerIdMap: matchedMap,
            unmatchedSourcePerformers,
            afterIndexResolver,
          });
          return;
        }
        insertBulkPastedSlidesIntoWork(
          clip.slides,
          clip.sourceInternalTransitionCounts,
          clip.sourceInternalTransitionPaths,
          matchedMap,
          afterIndexResolver
        );
        return;
      }
      insertBulkPastedSlidesIntoWork(
        clip.slides,
        clip.sourceInternalTransitionCounts,
        clip.sourceInternalTransitionPaths,
        null,
        afterIndexResolver
      );
    },
    [workspace.activeProjectId, performers, insertBulkPastedSlidesIntoWork]
  );

  // Project間コピー v1・5章：未一致出演者がいる場合の「Paste実行前の確認」待ちstate。
  // work／Undo対象外のUI専用一時state。単体（sourceSlide）・複数（sourceSlides＋内部transition
  // map＋afterIndexResolver）のどちらか一方だけが入る（複数構成一括コピー v1・STEP8で拡張）。
  // 確認待ち時点のtargetProjectId（確認前にProjectが切り替わっていた場合の安全側ガード用）を
  // 保持する。「そのまま貼り付ける」が押されたときにだけ実際の挿入を行う。
  const [pendingCrossProjectPaste, setPendingCrossProjectPaste] = useState(null);

  const confirmCrossProjectPaste = useCallback(() => {
    if (!pendingCrossProjectPaste) return;
    if (pendingCrossProjectPaste.targetProjectId === workspace.activeProjectId) {
      if (Array.isArray(pendingCrossProjectPaste.sourceSlides)) {
        insertBulkPastedSlidesIntoWork(
          pendingCrossProjectPaste.sourceSlides,
          pendingCrossProjectPaste.sourceInternalTransitionCounts,
          pendingCrossProjectPaste.sourceInternalTransitionPaths,
          pendingCrossProjectPaste.performerIdMap,
          pendingCrossProjectPaste.afterIndexResolver
        );
      } else {
        insertCrossProjectPastedSlide(pendingCrossProjectPaste.sourceSlide, pendingCrossProjectPaste.performerIdMap);
      }
    }
    setPendingCrossProjectPaste(null);
  }, [pendingCrossProjectPaste, workspace.activeProjectId, insertCrossProjectPastedSlide, insertBulkPastedSlidesIntoWork]);

  const cancelCrossProjectPaste = useCallback(() => {
    setPendingCrossProjectPaste(null);
  }, []);

  // 内部clipboardの内容を「現在の構成の直後」へ新しい構成として貼り付ける（7章）。
  // ・出演者が1人以上選択されている場合、再生中・一時停止中は何もしない（15章・28〜29章）。
  // ・clipboardが未設定（一度もCopyしていない）場合も何もしない（12章：クラッシュしない）。
  // ・貼り付けるたびにdeepCopyPlainObjectをもう一度通すことで、同じclipboardから複数回
  //   貼り付けても、貼り付けたslide同士がplacementsオブジェクトを共有しないようにする（11章。
  //   insertSlideCopyAfter自体も内部でdeepCopyPlainObjectするため、意図的に「保存済みの
  //   deep copyを、さらにもう一段deep copyする」という元の挙動をそのまま維持している）。
  // ・新しいslideには必ず新規idを発行する（元slideのidを複製しない＝9章）。
  // ・構成名は元構成名をそのまま引き継ぐ（10章：操作性優先、命名仕様を複雑にしない）。
  // ・新しく生まれる隣接ペアのtransitionCounts/transitionPathsは、insertSlideCopyAfter内部の
  //   reconcile処理により既定値へ自動フォールバックする（5章・14章）。
  // ・貼り付けは1回のcommitWork＝1件のUndo履歴（13章）。
  // ・貼り付け後は新しいslideをcurrentSlideIndexとして選択する（8章）。
  //
  // Project間コピー v1・2章：clip.sourceProjectIdが現在のactiveProjectIdと異なる場合だけ、
  // Project間コピー専用の経路（出演者対応付け→未一致があれば確認待ち→insertCrossProjectPastedSlide）
  // へ分岐する。この分岐に入らない限り（＝同一Project内での貼り付け、これまでの主要なケース）は、
  // 以下の処理はこれまでと全く同じままである（20章：既存挙動を変えない）。
  //
  // 複数構成一括コピー v1・STEP12：clip.slides（複数）が存在する場合は、単体分岐より先に
  // executeBulkPasteへ委譲する（Ctrl+Vでも構成一覧の「この後に貼り付け」と同じbulk paste
  // 処理を使う＝重複実装しない）。単体Ctrl+V（clip.slide）はこれまでと全く同じ処理のまま。
  const pasteCopiedSlide = useCallback(() => {
    if (isTransitionActive) return;
    if (selectedIds.length > 0) return;
    const clip = copiedSlideRef.current;
    if (!clip) return;
    if (Array.isArray(clip.slides)) {
      executeBulkPaste((prev) => prev.currentSlideIndex);
      return;
    }
    if (!clip.slide) return;
    if (clip.sourceProjectId && clip.sourceProjectId !== workspace.activeProjectId) {
      const { matchedMap, unmatchedSourcePerformers } = buildCrossProjectPerformerMapping(
        clip.slide,
        clip.sourcePerformersSnapshot,
        performers
      );
      if (unmatchedSourcePerformers.length > 0) {
        setPendingCrossProjectPaste({
          sourceProjectId: clip.sourceProjectId,
          targetProjectId: workspace.activeProjectId,
          sourceSlide: clip.slide,
          performerIdMap: matchedMap,
          unmatchedSourcePerformers,
        });
        return;
      }
      insertCrossProjectPastedSlide(clip.slide, matchedMap);
      return;
    }
    commitWork((prev) => {
      const latestClip = copiedSlideRef.current;
      if (!latestClip || !latestClip.slide) return prev; // 保険（コミット関数実行時点の再チェック）
      const insertAt = prev.currentSlideIndex;
      const { nextSlides, nextTransitionCounts, nextTransitionPaths, newSlideId } = insertSlideCopyAfter(
        prev.slides,
        prev.transitionCounts,
        prev.transitionPaths,
        latestClip.slide,
        insertAt
      );
      const nextCurrentIndex = nextSlides.findIndex((s) => s.id === newSlideId);
      return {
        ...prev,
        slides: nextSlides,
        currentSlideIndex: nextCurrentIndex === -1 ? prev.currentSlideIndex : nextCurrentIndex,
        transitionCounts: nextTransitionCounts,
        transitionPaths: nextTransitionPaths,
      };
    });
  }, [
    isTransitionActive,
    selectedIds,
    commitWork,
    workspace.activeProjectId,
    performers,
    insertCrossProjectPastedSlide,
    executeBulkPaste,
  ]);

  // ==============================================================
  // 構成一覧v2・第2段階①：任意位置への構成コピー＆ペースト
  // ==============================================================
  // 上記のcopiedSlideRef（Ctrl+C/Ctrl+V用の内部clipboard）とは完全に独立した、構成一覧
  // モーダル専用のコピーstate。UIへ「コピー中：構成N ○○」と表示する必要があるため、
  // 再描画をトリガーしないref ではなくuseStateで持つ（4章）。
  // copiedSlideIdは「コピー元slideのid」だけを保持する（4・12章：indexやsnapshotではなくid）。
  // これにより、コピー後にDnDで並び替えが起きても、貼り付け時にid経由で常に正しい構成を
  // 解決できる。work/project/slideには一切保存せず、Undo/Redo対象外（10章）。
  const [copiedSlideId, setCopiedSlideId] = useState(null);

  // コピー元slideが削除された場合、コピーstateを自動的に解除する（11章）。
  // 「コピー中」表示が壊れた参照を指し続けたり、貼り付けようとして無反応になったりする
  // ことを防ぐ、最もシンプルで自然なUX（エラー表示は不要）。
  useEffect(() => {
    if (copiedSlideId && !slides.some((s) => s.id === copiedSlideId)) {
      setCopiedSlideId(null);
    }
  }, [slides, copiedSlideId]);

  // 構成一覧の「⋯」メニュー「コピー」：指定indexの構成をコピー元として保持するだけで、
  // work（slides等）は一切変更しない＝Undo履歴を作らない（3章のUX要件を満たす）。
  const copySlideAt = useCallback(
    (index) => {
      const slide = slides[index];
      if (!slide) return;
      setCopiedSlideId(slide.id);
    },
    [slides]
  );

  // 「解除」：コピーstateを消すだけ。Undo履歴には一切入らない。
  const clearCopiedSlide = useCallback(() => {
    setCopiedSlideId(null);
  }, []);

  // ==============================================================
  // 構成一覧v2・第2段階②：コピー／貼り付けの視覚フィードバック改善（PART C・D・E）
  // ==============================================================
  // 「この後に貼り付け」を実行した直後、新しく生成されたslideカードだけを約1秒間強調する。
  // recentlyPastedSlideIdはReactの一時的なUI stateであり、work/project/slideには一切保存
  // しない（PART C：非常に重要）。indexではなく必ずslide.idで保持することで、貼り付け直後に
  // 並び替え等が起きても正しいカードを強調できる（copiedSlideIdと全く同じ設計方針）。
  const [recentlyPastedSlideId, setRecentlyPastedSlideId] = useState(null);
  // PART E：setTimeoutのIDをrefで保持し、短時間に連続貼り付けが起きた場合は必ず古いtimerを
  // clearしてから新しいtimerを張り直す。これにより「1個目の貼り付け → 0.3秒後に2個目」の
  // ようなケースでも、古いtimeoutが新しいカードのhighlightを途中で消すことがない。
  const recentlyPastedTimeoutRef = useRef(null);
  const highlightRecentlyPastedSlide = useCallback((slideId) => {
    if (recentlyPastedTimeoutRef.current != null) clearTimeout(recentlyPastedTimeoutRef.current);
    setRecentlyPastedSlideId(slideId);
    recentlyPastedTimeoutRef.current = setTimeout(() => {
      setRecentlyPastedSlideId(null);
      recentlyPastedTimeoutRef.current = null;
    }, 1000); // 約1秒（PART C・E）
  }, []);
  // component unmount時にもtimerを残さない（PART E）。
  useEffect(() => {
    return () => {
      if (recentlyPastedTimeoutRef.current != null) clearTimeout(recentlyPastedTimeoutRef.current);
    };
  }, []);

  // 構成一覧の「⋯」メニュー「ここに貼り付け」：copiedSlideId（コピー元のid）を、指定した
  // targetIndexの構成の直後へ挿入する。ソースは必ずid経由で毎回commit時点のprev.slidesから
  // 解決するため（12章）、コピー後にDnDで並び替えが起きていても正しい構成が貼り付けられる。
  // insertSlideCopyAfter()を使うため、複製（duplicateSlideAt）・キーボード貼り付け
  // （pasteCopiedSlide）と全く同じreconcileルールが適用される（8・9章：新しく生まれた
  // 隣接ペアには旧いtransitionCounts/transitionPathsを一切引き継がせない）。
  // currentSlideIndexは、duplicateSlideAtと同じ「貼り付け位置より後ろにあった場合だけ
  // 追従」方針にする（構成一覧を操作している間、メイン編集画面を意図せず切り替えない）。
  const pasteSlideAfterIndex = useCallback(
    (targetIndex) => {
      if (isTransitionActive) return;
      if (!copiedSlideId) return;
      // PART D：insertSlideCopyAfter()の返り値（newSlideId）をcommitWorkのupdater内で
      // 外側のローカル変数へキャプチャするだけで、「今回生成されたslide.id」を安全に取得する。
      // コピー処理を二重実装せず、既存のinsertSlideCopyAfter()の戻り値をそのまま使う。
      let pastedSlideId = null;
      commitWork((prev) => {
        if (targetIndex < 0 || targetIndex >= prev.slides.length) return prev;
        const srcIndex = prev.slides.findIndex((s) => s.id === copiedSlideId);
        if (srcIndex === -1) return prev; // 保険：コピー元が既に無い場合は何もしない（11章）
        const src = prev.slides[srcIndex];
        const { nextSlides, nextTransitionCounts, nextTransitionPaths, newSlideId } = insertSlideCopyAfter(
          prev.slides,
          prev.transitionCounts,
          prev.transitionPaths,
          src,
          targetIndex
        );
        pastedSlideId = newSlideId;
        const nextCurrentIndex = prev.currentSlideIndex > targetIndex ? prev.currentSlideIndex + 1 : prev.currentSlideIndex;
        return {
          ...prev,
          slides: nextSlides,
          currentSlideIndex: nextCurrentIndex,
          transitionCounts: nextTransitionCounts,
          transitionPaths: nextTransitionPaths,
        };
      });
      // PART C：実際に挿入できた場合だけ、新しいslideを約1秒強調する（guard節等で
      // commitWorkのupdaterがprevをそのまま返した＝何も変わらなかった場合はpastedSlideIdが
      // nullのままなので、ここでは何もしない）。
      if (pastedSlideId) {
        highlightRecentlyPastedSlide(pastedSlideId);
      }
    },
    [isTransitionActive, copiedSlideId, commitWork, highlightRecentlyPastedSlide]
  );

  // 複数構成一括コピー v1・STEP12：構成一覧「この後に貼り付け」の入口を1本化する。
  // copiedSlideRefが複数選択からの一括clipboard（slidesキー）を保持している場合は、
  // そちらを最優先でexecuteBulkPasteへ委譲する（Ctrl+Vと全く同じbulk paste処理を再利用し、
  // 「この後に貼り付け」専用の別実装は作らない＝「複数Ctrl+Vだけ別の簡易実装を作らない」と
  // 同じ方針）。保持していない場合は、従来通りcopiedSlideId（「⋯」メニュー単体コピー）による
  // 既存のpasteSlideAfterIndexへそのままフォールバックする（既存の単体・同一Project内専用機能は
  // 無変更のまま維持する）。
  const pasteAfterIndexUnified = useCallback(
    (targetIndex) => {
      if (isTransitionActive) return;
      const clip = copiedSlideRef.current;
      if (clip && Array.isArray(clip.slides) && clip.slides.length > 0) {
        executeBulkPaste(() => targetIndex);
        return;
      }
      pasteSlideAfterIndex(targetIndex);
    },
    [isTransitionActive, executeBulkPaste, pasteSlideAfterIndex]
  );


  // 構成の並べ替え（左右移動ボタン用の共通処理）。fromIndex/toIndexを渡すだけの汎用関数にしてあるので、
  // 将来ドラッグ＆ドロップに拡張する場合もこの関数をそのまま呼び出せる。
  // placementsなど構成の中身・idは一切変更せず、slides配列内の並び順だけを入れ替える。
  const moveSlide = useCallback(
    (fromIndex, toIndex) => {
      if (isTransitionActive) return; // 再生中は構成の追加・削除・並べ替えを無効化
      commitWork((prev) => {
        const len = prev.slides.length;
        if (fromIndex < 0 || fromIndex >= len || toIndex < 0 || toIndex >= len || fromIndex === toIndex) {
          return prev;
        }
        const nextSlides = [...prev.slides];
        const [moved] = nextSlides.splice(fromIndex, 1);
        nextSlides.splice(toIndex, 0, moved);

        // 選択中の構成が移動対象そのものならそのまま追従させる。
        // それ以外は、間に挟まれて相対位置がずれた分だけcurrentSlideIndexを補正する
        // （将来、選択中でない構成をドラッグで動かした場合にも正しく追従させるための処理）。
        let nextCurrentIndex = prev.currentSlideIndex;
        if (prev.currentSlideIndex === fromIndex) {
          nextCurrentIndex = toIndex;
        } else if (fromIndex < prev.currentSlideIndex && toIndex >= prev.currentSlideIndex) {
          nextCurrentIndex = prev.currentSlideIndex - 1;
        } else if (fromIndex > prev.currentSlideIndex && toIndex <= prev.currentSlideIndex) {
          nextCurrentIndex = prev.currentSlideIndex + 1;
        }
        // 並べ替えで隣接関係が変わったペアは、reconcileTransitionCountsにより
        // 自動的に既定値（DEFAULT_TRANSITION_COUNTS）へフォールバックする（複雑な自動引き継ぎは行わない）。
        const nextTransitionCounts = reconcileTransitionCounts(prev.transitionCounts, prev.slides, nextSlides);
        const nextTransitionPaths = reconcileTransitionPaths(prev.transitionPaths, prev.slides, nextSlides);
        return {
          ...prev,
          slides: nextSlides,
          currentSlideIndex: nextCurrentIndex,
          transitionCounts: nextTransitionCounts,
          transitionPaths: nextTransitionPaths,
        };
      });
    },
    [commitWork, isTransitionActive]
  );
  // 従来の←/→ボタン用ラッパー（moveCurrentSlideLeft/Right）は構成バーのドラッグ＆ドロップ
  // 並べ替えに置き換えたため削除した。ドラッグ＆ドロップは下記の通りmoveSlideを直接再利用する
  // （CompositionBarへ onReorder={moveSlide} として渡す）。

  // ------------------------------------------------------------
  // 構成間の移動カウント（現在の構成 → 次の構成）の編集
  // ------------------------------------------------------------
  // 「現在選択中の構成に次の構成があるかどうか」。最後の構成の場合はfalseになり、
  // 呼び出し側（UI）でカウント変更操作をdisabledにする判定に使う。
  const hasNextSlideForTransition = currentSlideIndex < slides.length - 1;
  // 現在の構成→次の構成の移動カウント（次の構成が無い場合はnull）
  const currentTransitionCounts = hasNextSlideForTransition
    ? getTransitionCounts(transitionCounts, currentSlide.id)
    : null;

  // ＋／−ボタン用：1クリック＝1回のcommit（＝1件のUndo履歴）として増減する。
  // 再生中は変更できない（誤操作防止・再生時間の途中変化を防ぐ）。
  const stepTransitionCounts = useCallback(
    (delta) => {
      if (isTransitionActive) return; // 再生中は移動カウントを変更できない
      commitWork((prev) => {
        const slide = prev.slides[prev.currentSlideIndex];
        if (!slide || prev.currentSlideIndex >= prev.slides.length - 1) return prev; // 次の構成が無ければ何もしない
        const cur = getTransitionCounts(prev.transitionCounts, slide.id);
        const next = Math.max(MIN_TRANSITION_COUNTS, cur + delta);
        if (next === cur) return prev;
        return { ...prev, transitionCounts: { ...prev.transitionCounts, [slide.id]: next } };
      });
    },
    [commitWork, isTransitionActive]
  );

  // 直接入力（draft確定時）用：既存のstepTransitionCounts（＋／−ボタン、delta方式）とは別に、
  // 「確定後の絶対値」を受け取って1件のcommitにする関数を用意する。入力操作の改善v2の
  // useDraftNumberInputフックは常にblur/Enter確定時の絶対値をonCommitへ渡す設計のため
  // （以前あった「入力中だけ見た目を更新するLive版」updateWorkLiveは不要になり削除した）。
  const setTransitionCountsCommit = useCallback(
    (rawValue) => {
      if (isTransitionActive) return; // 再生中は移動カウントを変更できない
      const parsed = Math.round(Number(rawValue));
      const next = Number.isFinite(parsed) ? Math.max(MIN_TRANSITION_COUNTS, parsed) : MIN_TRANSITION_COUNTS;
      commitWork((prev) => {
        const slide = prev.slides[prev.currentSlideIndex];
        if (!slide || prev.currentSlideIndex >= prev.slides.length - 1) return prev;
        const cur = getTransitionCounts(prev.transitionCounts, slide.id);
        if (next === cur) return prev;
        return { ...prev, transitionCounts: { ...prev.transitionCounts, [slide.id]: next } };
      });
    },
    [commitWork, isTransitionActive]
  );

  // 「一覧表示」：構成一覧モーダル（通常モード）の開閉。Export Center v1導入後も、
  // 「カードクリック→goToSlide→モーダルを閉じる」という従来の動作は一切変更しない（17章）。
  const [slideListOpen, setSlideListOpen] = useState(false);

  // ------------------------------------------------------------
  // Export Center v1（PNG Export基盤を土台に、出力の入口を1つへ集約する）
  // ------------------------------------------------------------
  // 責務の分離（22章）：
  //   「どの構成を出力するか」   … exportTargetMode / selectedExportSlideIds（このセクション）
  //   「どう描画するか」         … exportShowWaitingAreas / exportShowTrajectory / exportTrajectoryMode /
  //                                exportViewChoice（表示オプション・ビュー・将来の「形式」）
  //   「実際に描画する」         … 既存のbuildFormationExportModel(s)・renderFormationExportToCanvas
  //                                （一切変更しない・二重実装しない＝25章）
  // この3層を分けておくことで、将来PDF/印刷/共有を追加する際は「描画する」層だけ差し替えれば済む。

  // pngExportErrorはExport Center v1でも「PNG生成・ダウンロード時のエラー表示」という役割のまま
  // 名前・意味を変えずに再利用する（新しい同等stateを作らない＝13章の方針をここにも適用）。
  // 表示場所だけを、常設の編集画面バナーからExport Centerモーダル内部へ移した（23章）。
  const [pngExportError, setPngExportError] = useState(null);
  // PNG Export v1.1由来のExport専用state。work/project/slidesには一切保存せず、Undo/Redo対象外
  // （21章）。Export Center導入後も新しい同等stateは作らず、このexportShowWaitingAreasを
  // そのまま「表示オプション：待機エリア」チェックボックスとして再利用する（13章）。
  const [exportShowWaitingAreas, setExportShowWaitingAreas] = useState(true);

  // Export音楽位置・音源内時間 v1：Export Centerの「音源内時間を表示」チェックボックス専用state。
  // work/project/slides・Project Backupには一切保存せず、Undo/Redo対象外（Export UI専用の
  // 表示オプション）。対応する編集画面側のstateが存在しないため、exportShowWaitingAreasと
  // 全く同じ扱い（openExportCenter側では毎回リセットせず、直前に設定した値をそのまま
  // 持ち越す）にする。defaultはOFF。
  const [exportShowMusicTime, setExportShowMusicTime] = useState(false);

  // Export Center専用の「移動軌跡」設定。既存の編集画面のshowTrajectory/trajectoryModeとは
  // 別に持つ（13章：showTrajectoryは構成間アニメーションのwaypoint編集UIの表示条件も兼ねる
  // “編集機能”であり、これをExport Centerが直接書き換えると「出力設定を変えただけなのに
  // 編集画面の見た目まで変わる」という副作用が生まれてしまうため、安全に移動できない）。
  // 「出力条件」として独立させつつ、Export Centerを開いた瞬間だけ編集画面の現在値をコピーする
  // ことで、2章の「初期値は現在使っているPNG設定を基本にする」を満たす。
  const [exportShowTrajectory, setExportShowTrajectory] = useState(false);
  const [exportTrajectoryMode, setExportTrajectoryMode] = useState("next");
  // 出演者名 v1：Export Center専用の「出演者名を表示」設定。exportShowTrajectoryと全く同じ
  // 考え方（work/Undo/Redoの対象外・Export Centerを開いた瞬間に編集画面の現在値をコピー）で
  // 独立させる。実際に描画へ反映するのはrenderTopFormationExportのみで、俯瞰客席ビュー側の
  // renderAudienceFormationExportへは常に渡さない（9・14章：常に名前非表示という確定仕様）。
  const [exportShowPerformerNames, setExportShowPerformerNames] = useState(false);
  // Export表示倍率 v1・PART D：auto-fit後の構図倍率（1.0=100%）。work/Project/slide/
  // placementには一切保存せず、Undo/Redo対象にもしないUI専用state。編集画面のzoom
  // （viewState.zoom）とは完全に独立した別のstateとして持つ（PART C：絶対に共有しない）。
  // exportShowPerformerNames等と異なり編集画面に対応する値が存在しないため、
  // Export Centerを開くたびに必ずEXPORT_DISPLAY_SCALE_DEFAULTへ戻す（openExportCenter内）。
  const [exportDisplayScale, setExportDisplayScale] = useState(EXPORT_DISPLAY_SCALE_DEFAULT);
  // Export Centerの「ビュー」選択："current"（現在のビューを使う）| "top"（平面図） | "front"（俯瞰客席）。
  // 既存のviewMode（"top"|"front"）と同じ語彙を使い、renderer側の語彙（"top"|"audience"）への
  // 変換は呼び出し箇所（resolveExportRenderViewMode）だけで行う（二重管理しない＝14章）。
  const [exportViewChoice, setExportViewChoice] = useState("current");
  // 出力対象："current"（現在の構成） | "selection"（構成を選択） | "all"（すべての構成）。
  const [exportTargetMode, setExportTargetMode] = useState("current");
  // Export Center v1.2：出力形式。"png"（既定・従来通り） | "pdf"（新規）。
  // PNG側の挙動（1構成=直接ダウンロード／2構成以上=ZIP）は一切変更せず、format==="pdf"の
  // 場合だけ別ブランチへ進む（handleExportCenterConfirm参照）。
  const [exportFormat, setExportFormat] = useState("png");
  // Export Center v1・7章：構成選択状態はwork/project/slideには一切保存しない、
  // Export Center専用のUI一時state（Undo/Redo対象外）。slide.idの配列で保持する
  // （並べ替え・削除等でindexがズレても、idベースなら安全に追従できるため）。
  const [selectedExportSlideIds, setSelectedExportSlideIds] = useState([]);
  const [exportCenterOpen, setExportCenterOpen] = useState(false);
  const [exportSlidePickerOpen, setExportSlidePickerOpen] = useState(false);
  const [exportBatchBusy, setExportBatchBusy] = useState(false);

  // 22章：再生中（isTransitionActiveがtrue＝再生中・一時停止中・同期再生中のいずれか）は
  // 「補間途中の位置」ではなく「保存されている構成そのもの」を出すのがこの機能の目的のため、
  // 既存のisTransitionActiveをそのまま再利用してExport Centerを開けないようにする
  // （新しいロック条件を作らない）。
  const pngExportDisabled = isTransitionActive;

  // Export Center v1・19章：Multi Project切替のたびに、Export用の一時選択state・
  // モーダル開閉状態をリセットする（他Projectのslidesが混ざらないようにする安全策。
  // Export用選択stateをWorkspaceへ保存する必要はない＝19章）。
  // 構成一覧v2・第2段階①・13章：同じ理由で、構成一覧の「コピー中」state（copiedSlideId）も
  // Project切替のたびに解除する。他Projectのslidesへ意図せず貼り付けられないようにするため。
  // 構成一覧v2・第2段階②・PART K：貼り付け直後の一時強調（recentlyPastedSlideId）も同様に
  // Project切替時にリセットし、対応するtimerも確実にclearする（別Projectのカードを誤って
  // 強調表示し続けることを防ぐ）。
  // Project間コピー v1・5章：未一致出演者の確認待ちモーダル（pendingCrossProjectPaste）も
  // 同じ理由でProject切替のたびに解除する（confirmCrossProjectPaste側にもtargetProjectIdの
  // 二重チェックがあるため実害は無いが、そもそも別Project向けの確認モーダルを残さない）。
  // copiedSlideRef（Ctrl+C/V本体のclipboard）自体はここでは触れない＝意図的にProject切替を
  // 生き延びさせる（Project間コピーの土台となる仕様）。
  // 複数構成一括コピー v1・STEP1：構成一覧の複数選択id配列（selectedCopySlideIds）も同じ理由で
  // Project切替のたびに解除する。copiedSlideRef（実際のclipboard本体）はここでは触れない
  // （既存単体分と同じく、意図的にProject切替を生き延びさせる）。
  useEffect(() => {
    setSelectedExportSlideIds([]);
    setExportCenterOpen(false);
    setExportSlidePickerOpen(false);
    setExportTargetMode("current");
    setExportFormat("png");
    setCopiedSlideId(null);
    setPendingCrossProjectPaste(null);
    setSelectedCopySlideIds([]);
    setPendingBulkSlideDeleteIds(null);
    if (recentlyPastedTimeoutRef.current != null) {
      clearTimeout(recentlyPastedTimeoutRef.current);
      recentlyPastedTimeoutRef.current = null;
    }
    setRecentlyPastedSlideId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.activeProjectId]);

  // 「出力」ボタン（旧PNG出力ボタン）を押した瞬間の処理。1章：直接PNGをダウンロードするのではなく
  // Export Centerモーダルを開くだけにする。2章：初期値は「現在の構成／現在のビュー／現在使っている
  // PNG設定」にするため、開く瞬間に編集画面の現在値（showTrajectory・trajectoryMode）をコピーする。
  // v1.2：形式は毎回PNGを既定にする（前回PDFを選んでいても、次に開いた時は必ずPNGから始まる＝
  // 既存のPNG主体の使い方に対する挙動を一切変えないための安全策）。
  const openExportCenter = useCallback(() => {
    if (isTransitionActive) return;
    setPngExportError(null);
    setExportTargetMode("current");
    setExportViewChoice("current");
    setExportShowTrajectory(showTrajectory);
    setExportTrajectoryMode(trajectoryMode);
    setExportShowPerformerNames(showPerformerNames);
    // Export表示倍率 v1：対応する編集画面stateが存在しないため、開くたびに必ず100%へ戻す
    // （PART C：編集画面のzoomとは無関係。TEST A「Export Centerを開く→100%表示」）。
    setExportDisplayScale(EXPORT_DISPLAY_SCALE_DEFAULT);
    setExportFormat("png");
    setExportCenterOpen(true);
  }, [isTransitionActive, showTrajectory, trajectoryMode, showPerformerNames]);

  const closeExportCenter = useCallback(() => {
    if (exportBatchBusy) return; // 出力処理中は閉じさせない（23章：中途半端な状態を残さない）
    setExportCenterOpen(false);
    setExportSlidePickerOpen(false);
  }, [exportBatchBusy]);

  // 出力用構成選択モードの選択操作（8・9章）。work/slidesには一切触れないため、Undo/Redoには影響しない。
  const toggleExportSlideSelection = useCallback((slideId) => {
    setSelectedExportSlideIds((prev) => (prev.includes(slideId) ? prev.filter((id) => id !== slideId) : [...prev, slideId]));
  }, []);
  const selectAllExportSlides = useCallback(() => {
    setSelectedExportSlideIds(slides.map((s) => s.id));
  }, [slides]);
  const clearExportSlideSelection = useCallback(() => {
    setSelectedExportSlideIds([]);
  }, []);

  // 5章：「構成を選択」を選ぶと、既存の構成一覧モーダルを「出力用選択モード」で開く。
  const openExportSlidePicker = useCallback(() => {
    setExportTargetMode("selection");
    setExportSlidePickerOpen(true);
  }, []);
  const closeExportSlidePicker = useCallback(() => {
    setExportSlidePickerOpen(false);
  }, []);

  // 「現在の構成／選択／すべての構成」から、出力対象のslide index配列を決定する（10・22章）。
  // 選択モードでは、選択された順ではなく必ずslides配列順になるよう、idからindexへ変換するだけで
  // 並べ替え自体はbuildFormationExportModels()側（既存の重複排除＋昇順ソート）に委譲する
  // （同じ「slide順に揃える」ロジックを2箇所に重複実装しない）。
  const getExportSlideIndices = useCallback(() => {
    if (exportTargetMode === "all") return slides.map((_, i) => i);
    if (exportTargetMode === "selection") {
      const idToIndex = new Map(slides.map((s, i) => [s.id, i]));
      return selectedExportSlideIds.map((id) => idToIndex.get(id)).filter((i) => typeof i === "number");
    }
    return [currentSlideIndex];
  }, [exportTargetMode, slides, selectedExportSlideIds, currentSlideIndex]);

  // Export Centerの「ビュー」選択→renderer語彙（"top"|"audience"）への変換（14章）。
  // 新しいCanvas描画エンジンは作らず、既存のrenderFormationExportToCanvas()をそのまま使う。
  const resolveExportRenderViewMode = useCallback(() => {
    const choice = exportViewChoice === "current" ? viewMode : exportViewChoice;
    return choice === "front" ? "audience" : "top";
  }, [exportViewChoice, viewMode]);

  const exportTargetSlideCount = getExportSlideIndices().length;
  const exportConfirmDisabled =
    exportBatchBusy || slides.length === 0 || (exportTargetMode === "selection" && selectedExportSlideIds.length === 0);
  // v1.2：形式（PNG/PDF）に応じてボタン文言を出し分ける。PNG側の文言は従来通り変更しない。
  const exportConfirmLabel = exportBatchBusy
    ? "出力中…"
    : exportFormat === "pdf"
    ? exportTargetMode === "current"
      ? "PDFを出力"
      : `${exportTargetSlideCount}構成をPDFで出力`
    : exportTargetMode === "current"
    ? "出力"
    : `${exportTargetSlideCount}構成を出力`;

  // Export Center v1.1・PART B・11〜14章：一括PNG出力の実処理。既存のbuildFormationExportModels()・
  // renderFormationExportToCanvas()をそのまま再利用し、model生成・描画のロジックは一切複製しない
  // （25章）。8章：出力対象が1構成だけの場合は、これまで通りPNG 1枚を直接ダウンロードする
  // （downloadCanvasAsPng()を使う既存の単体出力フローは書き換えない）。2構成以上の場合だけ、
  // Export Model → Canvas → PNG Blob（canvasToPngBlob） → ZIPへ追加、という流れでJSZipへ集約し、
  // 最後に1回だけdownloadBlob()でZIPをダウンロードする（downloadCanvasAsPng()をmodel数だけ
  // 呼ぶ旧方式は廃止＝ブラウザの連続ダウンロード制限による「一部しか落ちてこない」問題の解消）。
  // 17章：複数出力時は、1枚でもCanvas生成・Blob変換・ZIP生成に失敗したら、部分的なZIPは
  // 作らず全体を失敗扱いにする（途中経過のダウンロードは一切発生しない）。
  const handleExportCenterConfirm = useCallback(async () => {
    setPngExportError(null);
    const indices = getExportSlideIndices();
    if (indices.length === 0) {
      setPngExportError("出力する構成がありません。");
      return;
    }
    setExportBatchBusy(true);
    try {
      // 14章：選択順（クリックした順）ではなく必ずslides配列順にする。この並べ替えは
      // buildFormationExportModels()自身が内部で行う（重複排除＋昇順ソート）ため、
      // ここで新しいソートロジックは実装しない。
      const models = buildFormationExportModels({
        slideIndices: indices,
        slides,
        performers,
        stage,
        zones,
        musicSections,
        transitionCounts,
        effectiveTransitionPathConfig,
        showTrajectory: exportShowTrajectory,
        trajectoryMode: exportTrajectoryMode,
        performerDisplayScale,
        showMusicTime: exportShowMusicTime,
      });
      if (models.length === 0) {
        setPngExportError("出力対象の構成が見つかりませんでした。");
        return;
      }
      const renderOptions = {
        viewMode: resolveExportRenderViewMode(),
        showWaitingAreas: exportShowWaitingAreas,
        // 出演者名 v1・10章：renderFormationExportToCanvas側で、viewModeが"top"の場合だけ
        // renderTopFormationExportへ渡される（"audience"の場合は常に無視される＝14章）。
        showPerformerNames: exportShowPerformerNames,
        // Export表示倍率 v1・PART G・H：viewModeがtop/audienceどちらでも同じ値を渡す
        // （renderFormationExportToCanvas側で両rendererへ共通して適用される）。
        displayScale: exportDisplayScale,
      };

      if (exportFormat === "pdf") {
        // Export Center v1.2：PDF出力。既存のExport Model→Canvas→PNG Blob（canvasToPngBlob）の
        // 流れは一切変更せず、生成したPNG Blobをそのままpdf-libでPDFの1ページへ埋め込むだけ。
        // 1構成でも複数構成でも常に「1つのPDFファイル（1構成なら1ページ、複数なら複数ページ）」
        // という単一の出力方式にする（PNG側の「1枚=直接DL／2枚以上=ZIP」という分岐は関係ない）。
        // 1件でも失敗したら例外を投げ、部分的なPDFは作らない（17章のZIPと同じ方針を踏襲）。
        const pdfDoc = await PDFDocument.create();
        for (const model of models) {
          const canvas = document.createElement("canvas");
          const ok = renderFormationExportToCanvas(model, canvas, renderOptions);
          if (!ok) {
            throw new Error(`構成${model.slideNumber}のPDF用Canvasを準備できませんでした。`);
          }
          const blob = await canvasToPngBlob(canvas);
          const pngBytes = new Uint8Array(await blob.arrayBuffer());
          const pngImage = await pdfDoc.embedPng(pngBytes);
          // Canvasは常にEXPORT_PNG_WIDTH×EXPORT_PNG_HEIGHT固定（renderFormationExportToCanvas内で
          // 設定済み）なので、そのままPDFページサイズとして使う（1pt=1pxとして扱う簡便な対応）。
          const page = pdfDoc.addPage([EXPORT_PNG_WIDTH, EXPORT_PNG_HEIGHT]);
          page.drawImage(pngImage, { x: 0, y: 0, width: EXPORT_PNG_WIDTH, height: EXPORT_PNG_HEIGHT });
        }
        const pdfBytes = await pdfDoc.save();
        const pdfBlob = new Blob([pdfBytes], { type: "application/pdf" });
        const pdfFilename = buildFormationExportPdfFilename(activeProject.name);
        downloadBlob(pdfBlob, pdfFilename, (err) => {
          throw err instanceof Error ? err : new Error("PDFファイルのダウンロードに失敗しました。");
        });
      } else if (models.length === 1) {
        // 8章：単体出力は既存の直接ダウンロード方式のまま（ZIP化しない）。
        const model = models[0];
        const canvas = document.createElement("canvas");
        const ok = renderFormationExportToCanvas(model, canvas, renderOptions);
        if (!ok) {
          throw new Error(`構成${model.slideNumber}のPNG描画用Canvasを準備できませんでした。`);
        }
        const filename = buildFormationExportFilename(model.slideNumber, model.slideName);
        await new Promise((resolve, reject) => {
          downloadCanvasAsPng(
            canvas,
            filename,
            (err) => reject(err instanceof Error ? err : new Error("PNGファイルの生成に失敗しました。")),
            () => resolve()
          );
        });
      } else {
        // 9・11〜14章：2構成以上はZIP 1ファイルにまとめて1回だけダウンロードする。
        // Canvas生成・PNG Blob変換のどこか1件でも失敗したら、部分的なZIPは作らず
        // 例外を投げて全体を失敗扱いにする（17章）。
        const zip = new JSZip();
        for (const model of models) {
          const canvas = document.createElement("canvas");
          const ok = renderFormationExportToCanvas(model, canvas, renderOptions);
          if (!ok) {
            throw new Error(`構成${model.slideNumber}のPNG描画用Canvasを準備できませんでした。`);
          }
          const blob = await canvasToPngBlob(canvas);
          const filename = buildFormationExportFilename(model.slideNumber, model.slideName);
          zip.file(filename, blob);
        }
        const zipBlob = await zip.generateAsync({ type: "blob" });
        const zipFilename = buildFormationExportZipFilename(activeProject.name);
        await new Promise((resolve, reject) => {
          try {
            downloadBlob(zipBlob, zipFilename, (err) => reject(err instanceof Error ? err : new Error("ZIPファイルのダウンロードに失敗しました。")));
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      }

      setExportCenterOpen(false);
      setExportSlidePickerOpen(false);
    } catch (err) {
      // 17章：「PNGの一括出力に失敗しました」という趣旨のメッセージを表示し、部分的な
      // ダウンロードは発生させない（ZIP/PDF生成前に例外を投げているため、不完全なファイルは
      // 作られない）。
      const label = exportFormat === "pdf" ? "PDFの出力に失敗しました。" : "PNGの一括出力に失敗しました。";
      setPngExportError(`${label}${err && err.message ? err.message : ""}`);
    } finally {
      setExportBatchBusy(false);
    }
  }, [
    getExportSlideIndices,
    slides,
    performers,
    stage,
    zones,
    musicSections,
    transitionCounts,
    effectiveTransitionPathConfig,
    exportShowTrajectory,
    exportTrajectoryMode,
    resolveExportRenderViewMode,
    exportShowWaitingAreas,
    exportShowPerformerNames,
    exportShowMusicTime,
    exportDisplayScale,
    performerDisplayScale,
    exportFormat,
    activeProject.name,
  ]);


  // 複数選択時の「選択中の出演者を削除」用の確認ダイアログ表示状態。

  // window.confirm() はサンドボックス化されたプレビュー環境（allow-modalsが無いiframe等）だと
  // 呼び出しがブロックされ、ダイアログが出ないまま何も起きないことがあるため、
  // ネイティブのconfirmには頼らずアプリ内の確認モーダルで確実に動作させる。
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);

  // 出演者一括追加 v1：「複数人追加」modalの開閉状態だけをReact側に持つ（UI一時state・
  // 17章：performer schemaや保存データへは一切混ぜない）。
  const [bulkAddPerformersOpen, setBulkAddPerformersOpen] = useState(false);

  // 重複位置の検出
  const overlapIds = useMemo(() => {
    const set = new Set();
    for (let i = 0; i < performers.length; i += 1) {
      for (let j = i + 1; j < performers.length; j += 1) {
        const a = placements[performers[i].id];
        const b = placements[performers[j].id];
        if (a && b && samePos(a, b)) {
          set.add(performers[i].id);
          set.add(performers[j].id);
        }
      }
    }
    return set;
  }, [performers, placements]);

  const outOfRangeCount = useMemo(
    () => performers.filter((p) => placements[p.id] && isBeyondAllAreas(placements[p.id], zones)).length,
    [performers, placements, zones]
  );

  // ---- スライド内のプレースメント更新用ヘルパー ----
  // updater は (placements, work全体) を受け取り、新しい placements を返す。
  // commit版＝即1件の履歴、live版＝履歴を増やさない見た目だけの更新（後で beginBatch/endBatch と組み合わせる）。
  const updateSlidePlacementsCommit = useCallback(
    (updater) => {
      commitWork((prev) => {
        const nextSlides = prev.slides.map((s, i) =>
          i === prev.currentSlideIndex ? { ...s, placements: updater(s.placements, prev) } : s
        );
        return { ...prev, slides: nextSlides };
      });
    },
    [commitWork]
  );
  const updateSlidePlacementsLive = useCallback(
    (updater) => {
      updateWorkLive((prev) => {
        const nextSlides = prev.slides.map((s, i) =>
          i === prev.currentSlideIndex ? { ...s, placements: updater(s.placements, prev) } : s
        );
        return { ...prev, slides: nextSlides };
      });
    },
    [updateWorkLive]
  );

  // 入力欄フォーカス〜blur/Enterの「編集セッション」ひとつを、履歴1件にまとめるための
  // 汎用ハンドラ。onFocus={beginEdit} / onBlur={endEdit} として使う。
  const beginEdit = useCallback(() => beginWorkBatch(), [beginWorkBatch]);
  const endEdit = useCallback(() => endWorkBatch(), [endWorkBatch]);
  // Enterキーで確定（＝blurさせてonBlurのendEditを発火させる）。
  // IME（日本語入力等）変換確定のEnterでは確定させない（PART B・C：isImeComposingEvent参照）。
  const commitOnEnter = useCallback((e) => {
    if (e.key !== "Enter") return;
    if (isImeComposingEvent(e)) return;
    e.currentTarget.blur();
  }, []);

  // ---- ステージ設定（＋／−ボタンは即コミット、直接入力はbeginEdit〜endEditで1件にまとめる） ----
  const setStageWidthCommit = useCallback((w) => {
    const clamped = clamp(Math.round(w), WIDTH_MIN, WIDTH_MAX);
    commitWork((prev) => ({ ...prev, stage: { ...prev.stage, width: clamped } }));
  }, [commitWork]);
  // 出演者表示サイズ v1・PART C・F：Project全体で1つの表示設定（work.project.performerDisplayScale）。
  // ステージ設定と同じく、ボタン操作は即コミット＝1回の操作で1件のUndo履歴にする。
  const setPerformerDisplayScaleCommit = useCallback(
    (scale) => {
      if (isTransitionActive) return;
      if (!PERFORMER_DISPLAY_SCALES.includes(scale)) return;
      commitWork((prev) => ({ ...prev, project: { ...prev.project, performerDisplayScale: scale } }));
    },
    [commitWork, isTransitionActive]
  );
  const setStageDepthCommit = useCallback((d) => {
    const clamped = clamp(Math.round(d), DEPTH_MIN, DEPTH_MAX);
    commitWork((prev) => ({ ...prev, stage: { ...prev.stage, depth: clamped } }));
  }, [commitWork]);
  const setStageWidthLive = useCallback((w) => {
    const clamped = clamp(Math.round(w), WIDTH_MIN, WIDTH_MAX);
    updateWorkLive((prev) => ({ ...prev, stage: { ...prev.stage, width: clamped } }));
  }, [updateWorkLive]);
  const setStageDepthLive = useCallback((d) => {
    const clamped = clamp(Math.round(d), DEPTH_MIN, DEPTH_MAX);
    updateWorkLive((prev) => ({ ...prev, stage: { ...prev.stage, depth: clamped } }));
  }, [updateWorkLive]);

  // ---- BPM（プロジェクト全体で共通の値。slideごとの値ではない） ----
  // ＋／－ボタン・DraftNumberFieldのblur/Enter確定、どちらもこの1つの関数を呼ぶだけで
  // 即1件のcommit＝1件のUndo履歴になる（20章）。入力操作の改善v2でDraftNumberField側が
  // draft文字列を保持するようになったため、以前あった「入力中だけ見た目を更新するLive版」
  // （updateWorkLive）は不要になり削除した。
  // 再生中・一時停止中は「このカウント数を何秒で再生するか」の前提が変わってしまうと
  // remainingDuration等の計算が壊れるため、isTransitionActive中は変更させない
  // （キープ数・移動時間と同じ安全策＝21章）。UI側（DraftNumberFieldのdisabled）でも
  // 同様にガードする。
  const setBpmCommit = useCallback(
    (rawValue) => {
      if (isTransitionActive) return;
      const next = clampBpm(rawValue);
      commitWork((prev) => {
        const cur = getProjectBpm(prev);
        if (next === cur) return prev;
        // prev.project が無い（BPM実装前の古いデータ）場合でも壊れないよう ||{} でガードする
        return { ...prev, project: { ...(prev.project || {}), bpm: next } };
      });
    },
    [commitWork, isTransitionActive]
  );

  // ---- Music Section（work.project.musicSections。作品データなのでUndo/Redo対象＝39章） ----
  // Section自体（startSec/countStartSec/bpm）は再生中に直接読み書きされる値ではなく、実際の
  // 再生時間計算はMusic Anchor経由でSectionを特定した時点のスナップショット的な値を使うため、
  // BPM欄と異なりisTransitionActiveによる編集ロックはかけていない（Section BPMは実際には
  // keep/move phaseの実時間計算・Music Anchorの絶対秒計算に使われている。19章の「メドレー対応」
  // 自体は既に実現済み）。
  // 追加・削除・フィールド更新のいずれも、内部的には必ずgetMusicSections(prev)経由で
  // 現在のSection配列（古いデータならデフォルト1件）を取得してから編集する。
  const addMusicSectionCommit = useCallback(() => {
    commitWork((prev) => {
      const current = getMusicSections(prev);
      const bpm = getProjectBpm(prev);
      const last = current[current.length - 1];
      const startSec = last && Number.isFinite(last.startSec) ? last.startSec : 0;
      const newSection = {
        id: makeId("section"),
        name: `${current.length + 1}曲目`, // 24章：初期値は「2曲目」「3曲目」など
        startSec, // 24章：前SectionのstartSec以上（同値を初期値にし、ユーザーが後で調整する想定）
        countStartSec: startSec, // 24章：startSecと同値
        bpm, // 24章：projectBpm
      };
      return { ...prev, project: { ...(prev.project || {}), musicSections: [...current, newSection] } };
    });
  }, [commitWork]);

  // Music Anchor v1（19章）：このSectionを参照しているslide.musicAnchorが残っていると、
  // 存在しないsectionIdを指す不正な状態になってしまう。Section削除と、それを参照している
  // 全slideのmusicAnchor解除（null化）を、必ず同じcommitWork＝1回のUndo履歴にまとめることで、
  // 「Section削除だけUndoしてAnchorはそのまま」のような不整合な中間状態を作らない（20章）。
  const removeMusicSectionCommit = useCallback(
    (sectionId) => {
      commitWork((prev) => {
        const current = getMusicSections(prev);
        if (current.length <= 1) return prev; // 25章：最後の1Sectionは削除不可
        const nextSlides = prev.slides.map((s) => {
          const anchor = getMusicAnchor(s);
          if (!anchor || anchor.sectionId !== sectionId) return s;
          return { ...s, musicAnchor: null };
        });
        return {
          ...prev,
          slides: nextSlides,
          project: { ...(prev.project || {}), musicSections: current.filter((s) => s.id !== sectionId) },
        };
      });
    },
    [commitWork]
  );

  // Section 1件のフィールド（name/startSec/countStartSec/bpm）を更新する汎用ヘルパー。
  // commit版＝即1件の履歴、live版＝beginEdit〜endEditと組み合わせて1編集セッション＝1件にまとめる
  // （他のテキスト・数値入力欄と同じパターン）。並べ替え（26章）は行わず、配列の並び順は
  // そのまま保持する（表示・時間区間の計算時にだけstartSec順を見る＝27章、31章のtimeSecToSectionPosition側で対応）。
  const updateMusicSectionCommit = useCallback(
    (sectionId, patch) => {
      commitWork((prev) => {
        const current = getMusicSections(prev);
        const next = current.map((s) => (s.id === sectionId ? { ...s, ...patch } : s));
        return { ...prev, project: { ...(prev.project || {}), musicSections: next } };
      });
    },
    [commitWork]
  );
  const updateMusicSectionLive = useCallback(
    (sectionId, patch) => {
      updateWorkLive((prev) => {
        const current = getMusicSections(prev);
        const next = current.map((s) => (s.id === sectionId ? { ...s, ...patch } : s));
        return { ...prev, project: { ...(prev.project || {}), musicSections: next } };
      });
    },
    [updateWorkLive]
  );

  // ---- Music Anchor（slide.musicAnchor。作品データなのでUndo/Redo対象＝20章） ----
  // Music Sectionと全く同じ方針でisTransitionActiveによる編集ロックはかけない。ただし
  // Music Section BPMと異なり、slide.musicAnchor自体を直接animation engineへdurationとして
  // 渡すわけではない：実際の再生時間計算では、Music Anchor（またはAuto Chainの自動計算結果）
  // から対象slideが属するMusic Sectionを特定し、そのSectionのBPMをkeep/move phaseの実時間へ
  // 使う（getEffectiveBpmForSlide参照）という間接的な経路になっている（27〜28章）。
  // 現在選択中の構成（currentSlideIndex）のmusicAnchorだけを対象にする共通ヘルパーを用意し、
  // 設定・解除・Section変更・eighthNumber変更・countOffset変更のすべてがこれを経由する
  // （更新ロジックの重複実装を避ける）。
  // Music Anchor Auto Chain v1・15章：自動計算されている構成でも、ユーザーがSection/eighthNumber/
  // countOffsetを編集した場合は、その時点で実際のslide.musicAnchorを新規作成し「手動Anchor」へ
  // 昇格させたい。そのため、updaterへ渡す「今の基準値」は「手動Anchorがあればそれ、無ければ
  // resolveSlideMusicPosition()の自動計算結果」（＝effectiveMusicAnchorと全く同じ考え方）にする。
  // commitWork内のprev（コミット直前の最新work）から都度計算し直すことで、レンダー時点の
  // effectiveMusicAnchor（クロージャ）とのズレを避ける。これにより、既存の
  // setMusicAnchorSectionCommit / setMusicAnchorEighthCommit / setMusicAnchorCountOffsetCommit の
  // 「prevAnchorがあれば{...prevAnchor, x}、無ければ何もしない」というupdaterはそのままで、
  // 自動表示中に編集すると自動的に新しい手動Anchorが作られるようになる（二重実装しない）。
  const updateCurrentSlideMusicAnchorCommit = useCallback(
    (updater) => {
      commitWork((prev) => {
        const idx = prev.currentSlideIndex;
        const slide = prev.slides[idx];
        if (!slide) return prev;
        const manualAnchor = getMusicAnchor(slide);
        const baseAnchor =
          manualAnchor ||
          (resolveSlideMusicPosition(prev.slides, idx, getMusicSections(prev), prev.transitionCounts) || {}).anchor ||
          null;
        const nextAnchor = updater(baseAnchor);
        return {
          ...prev,
          slides: prev.slides.map((s, i) =>
            i === idx
              ? {
                  ...s,
                  musicAnchor: nextAnchor,
                  // 再生開始モード v1・STEP10：手動Anchorを解除した場合（nextAnchor===null）は、
                  // musicPlaybackStartModeも"anchor"へ戻す（解除後は実質無効になるため、古い
                  // "sectionStart"設定を残留させない）。Section変更・eighthNumber/countOffset編集・
                  // 新規設定（nextAnchorがオブジェクト）の場合はmusicPlaybackStartModeに触れない。
                  ...(nextAnchor === null ? { musicPlaybackStartMode: "anchor" } : {}),
                }
              : s
          ),
        };
      });
    },
    [commitWork]
  );

  // 8章（Music Anchor v1）：「音楽位置を設定」。手動Anchor・自動計算のどちらも無い構成
  // （18章：前方に手動Anchorが無い場合だけ）に、既定値（Music Sectionの先頭・第1エイト・
  // countOffset0）で新規に割り当てる。Music Sectionが1件も無い状態は無い（15章）ため、
  // musicSections[0]は常に存在する。
  const enableMusicAnchorCommit = useCallback(() => {
    updateCurrentSlideMusicAnchorCommit((prevAnchor) => {
      if (prevAnchor) return prevAnchor; // 既に手動または自動の位置があれば何もしない（保険）
      const firstSection = musicSections[0];
      if (!firstSection) return prevAnchor;
      return { sectionId: firstSection.id, eighthNumber: MIN_MUSIC_ANCHOR_EIGHTH, countOffset: MIN_MUSIC_ANCHOR_COUNT_OFFSET };
    });
  }, [updateCurrentSlideMusicAnchorCommit, musicSections]);

  // 21章：「音楽位置を解除」。nullへ戻す（手動Anchorだった場合のみ意味を持つ操作。自動表示中は
  // 解除ボタン自体をUI側で出さない）。解除後は、前方に別の有効な手動AnchorがあればeffectiveMusicAnchor
  // が自動的にその自動計算結果へ戻る（17章：「解除→未設定」ではなく「解除→自動」）。
  const clearMusicAnchorCommit = useCallback(() => {
    updateCurrentSlideMusicAnchorCommit(() => null);
  }, [updateCurrentSlideMusicAnchorCommit]);

  // 16章：「この位置を手動Anchorにする」。今の自動計算結果（baseAnchor＝effectiveMusicAnchorと
  // 同じ値）をそのままslide.musicAnchorへ保存し、手動Anchorへ固定する。これにより、それより前の
  // 構成のkeep/transitionを後から変更しても、この構成以降は影響を受けなくなる（9章の境界と同じ
  // 効果を、ユーザーが明示的に作れるようにする操作）。
  const promoteAutoMusicAnchorToManualCommit = useCallback(() => {
    updateCurrentSlideMusicAnchorCommit((prevAnchor) => prevAnchor);
  }, [updateCurrentSlideMusicAnchorCommit]);

  // 再生開始モード v1・STEP3：現在構成の手動Music Anchorに対するmusicPlaybackStartModeを
  // 設定する（"anchor"｜"sectionStart"）。手動Anchorが無い構成（Auto Chainの自動表示のみ）では
  // 意味を持たないため、コミット時点のslideにgetMusicAnchorが存在しない場合は何もしない
  // （5章：UI側もgetMusicAnchor(currentSlide)がある場合だけこの操作を表示する二重の安全策）。
  // musicAnchor自体（updateCurrentSlideMusicAnchorCommit）とは別の1フィールドだけの更新のため、
  // 専用のcommitWork呼び出しにする。
  const setMusicPlaybackStartModeCommit = useCallback(
    (mode) => {
      const nextMode = mode === "sectionStart" ? "sectionStart" : "anchor";
      commitWork((prev) => {
        const idx = prev.currentSlideIndex;
        const slide = prev.slides[idx];
        if (!slide || !getMusicAnchor(slide)) return prev; // 手動Anchorが無ければ何もしない（保険）
        return {
          ...prev,
          slides: prev.slides.map((s, i) => (i === idx ? { ...s, musicPlaybackStartMode: nextMode } : s)),
        };
      });
    },
    [commitWork]
  );

  // 18章：参照するMusic Sectionを変更する。eighthNumber・countOffsetはそのまま維持する
  // （例：1曲目・8エイト → 2曲目へ変更 → 2曲目・8エイト）。自動表示中に変更した場合は、
  // 上のupdateCurrentSlideMusicAnchorCommitの仕組みにより自動的に手動Anchorへ昇格する（15章）。
  const setMusicAnchorSectionCommit = useCallback(
    (sectionId) => {
      updateCurrentSlideMusicAnchorCommit((prevAnchor) => (prevAnchor ? { ...prevAnchor, sectionId } : prevAnchor));
    },
    [updateCurrentSlideMusicAnchorCommit]
  );

  // エイト番号：＋／−ボタン・DraftNumberFieldのblur/Enter確定、どちらもこの1つの関数を
  // 呼ぶだけで即1件のcommit＝1件のUndo履歴になる（20章）。入力操作の改善v1でDraftNumberField
  // 側がdraft文字列を保持するようになったため、以前あった「入力中だけ見た目を更新するLive版」
  // （updateWorkLive）は不要になり削除した（確定時の1回のcommitだけで十分になったため）。
  // 自動表示中に編集した場合は、同じくupdateCurrentSlideMusicAnchorCommit側の仕組みで
  // 自動的に手動Anchorへ昇格する（15章）。
  const setMusicAnchorEighthCommit = useCallback(
    (rawValue) => {
      const parsed = Math.round(Number(rawValue));
      const next = Number.isFinite(parsed) ? clamp(parsed, MIN_MUSIC_ANCHOR_EIGHTH, MAX_MUSIC_ANCHOR_EIGHTH) : MIN_MUSIC_ANCHOR_EIGHTH;
      updateCurrentSlideMusicAnchorCommit((prevAnchor) => (prevAnchor ? { ...prevAnchor, eighthNumber: next } : prevAnchor));
    },
    [updateCurrentSlideMusicAnchorCommit]
  );

  // カウント：UI入力値は1〜8（musicAnchorDisplayCountToOffsetで内部の0〜7へ変換する）。
  // 内部のcountOffset自体は引き続き0〜7にクランプする（12章：8以上への繰り上がりは作らない。
  // 内部表現は変更しない＝Music Anchorカウント表示1〜8化 v1）。
  // エイト番号と同じ理由で、Live版は持たずcommit版のみにしてある。
  const setMusicAnchorCountOffsetCommit = useCallback(
    (rawDisplayValue) => {
      const parsedDisplay = Math.round(Number(rawDisplayValue));
      const minDisplay = musicAnchorCountOffsetToDisplayCount(MIN_MUSIC_ANCHOR_COUNT_OFFSET);
      const maxDisplay = musicAnchorCountOffsetToDisplayCount(MAX_MUSIC_ANCHOR_COUNT_OFFSET);
      const displayValue = Number.isFinite(parsedDisplay) ? clamp(parsedDisplay, minDisplay, maxDisplay) : minDisplay;
      const next = musicAnchorDisplayCountToOffset(displayValue);
      updateCurrentSlideMusicAnchorCommit((prevAnchor) => (prevAnchor ? { ...prevAnchor, countOffset: next } : prevAnchor));
    },
    [updateCurrentSlideMusicAnchorCommit]
  );

  // 25章（任意機能）：「現在の音楽位置から設定」。musicCurrentTime（Web Audioの現在再生位置）を
  // timeSecToSectionPosition()へ渡し、該当Section・エイト位置から最も近いeighthNumber/countOffsetへ
  // 変換する。countStartSecより前（beforeCountStart）の場合は第1エイト・countOffset0にする。
  // 既存のpure helperをそのまま再利用するだけで、新しい変換ロジックは作らない。
  const setMusicAnchorFromCurrentMusicTimeCommit = useCallback(() => {
    const position = timeSecToSectionPosition(musicCurrentTime, musicSections);
    if (!position) return;
    const section = musicSections[position.sectionIndex];
    if (!section) return;
    if (position.beforeCountStart) {
      updateCurrentSlideMusicAnchorCommit(() => ({ sectionId: section.id, eighthNumber: MIN_MUSIC_ANCHOR_EIGHTH, countOffset: MIN_MUSIC_ANCHOR_COUNT_OFFSET }));
      return;
    }
    const roundedCounts = Math.round(position.countPosition);
    const eighthNumber = clamp(Math.floor(roundedCounts / COUNTS_PER_EIGHT) + 1, MIN_MUSIC_ANCHOR_EIGHTH, MAX_MUSIC_ANCHOR_EIGHTH);
    const countOffset = clamp(roundedCounts - (eighthNumber - 1) * COUNTS_PER_EIGHT, MIN_MUSIC_ANCHOR_COUNT_OFFSET, MAX_MUSIC_ANCHOR_COUNT_OFFSET);
    updateCurrentSlideMusicAnchorCommit(() => ({ sectionId: section.id, eighthNumber, countOffset }));
  }, [musicCurrentTime, musicSections, updateCurrentSlideMusicAnchorCommit]);

  // ---- 構成名（現在選択中の構成のnameを編集パネルから変更する） ----
  // 入力中はupdateWorkLiveで見た目だけ更新し、フォーカス〜blur/Enterの1編集セッションを
  // beginEdit〜endEditで1件の履歴にまとめる（他のテキスト入力欄と同じパターン）。
  const setCurrentSlideNameLive = useCallback(
    (name) => {
      updateWorkLive((prev) => ({
        ...prev,
        slides: prev.slides.map((s, i) => (i === prev.currentSlideIndex ? { ...s, name } : s)),
      }));
    },
    [updateWorkLive]
  );
  // blur時、名前が空文字（空白のみを含む）のままなら「構成 N」の自動名へ戻してから
  // 編集セッションを確定する。この戻し処理も同じ1件の履歴に含まれる。
  const handleSlideNameBlur = useCallback(() => {
    updateWorkLive((prev) => {
      const cur = prev.slides[prev.currentSlideIndex];
      if (cur.name.trim() !== "") return prev;
      const autoName = nextAutoSlideName(prev.slides);
      return {
        ...prev,
        slides: prev.slides.map((s, i) => (i === prev.currentSlideIndex ? { ...s, name: autoName } : s)),
      };
    });
    endEdit();
  }, [updateWorkLive, endEdit]);

  // 構成名入力欄のIME（日本語変換など）対応。
  // 変換確定のEnterはブラウザ・IME側の処理に任せ、アプリ側のblur()は発火させない。
  // isComposingが取れない一部環境向けに、compositionStart/Endでのフラグ管理も併用する
  // （isImeComposingEventの判定に加え、この欄専用のrefでも二重に保険をかける）。
  const slideNameComposingRef = useRef(false);
  const handleSlideNameCompositionStart = useCallback(() => {
    slideNameComposingRef.current = true;
  }, []);
  const handleSlideNameCompositionEnd = useCallback(() => {
    slideNameComposingRef.current = false;
  }, []);
  const handleSlideNameKeyDown = useCallback((e) => {
    if (e.key !== "Enter") return;
    if (isImeComposingEvent(e) || slideNameComposingRef.current) {
      // IME変換確定のためのEnter。ここでは構成名を確定させない（二重入力の原因になるため）。
      return;
    }
    e.currentTarget.blur();
  }, []);

  // ---- キープ（現在選択中の構成が何カウント維持されるか）----
  // transitionCountsは work 直下の独立したマップ（構成と構成の「間」の属性）だが、
  // keepCountsは構成（slide）そのものの属性のため、「現在のslideオブジェクト1件を
  // 更新する」形にする（＝slides配列をmapし、currentSlideIndexの要素だけ差し替える）。
  // これにより、構成の削除・並べ替えではkeepCountsも自動的にslideと一緒に移動/消滅し、
  // transitionCountsのような隣接ペアの再計算（reconcile）は一切不要になる。
  const currentKeepCounts = getKeepCounts(currentSlide);

  // 前後のカウント補助表示 v1：現在構成を開いたまま「前から何カウントで入ってきて、
  // 何カウントキープし、次へ何カウントで移動するか」をすぐ確認できるようにするための
  // 表示専用の派生値。新しいstateは持たず、slides/currentSlideIndex/transitionCountsから
  // 毎回そのまま計算するだけ（構成を切り替えれば自動的に値も切り替わる＝11章）。
  // transitionCountsは既存の「移動元slide.id」をキーにする所有関係のまま、
  // 既存のgetTransitionCounts()を再利用する（新しい移動時間計算は作らない）。
  // 前（または次）の構成そのものが存在しない場合はnullのままにし、「0count」とは
  // 明確に区別する（表示側でnull→「—」、0→「0 count」と出し分ける＝7〜8章）。
  const previousSlideForCounts = currentSlideIndex > 0 ? slides[currentSlideIndex - 1] : null;
  const previousTransitionCounts = previousSlideForCounts
    ? getTransitionCounts(transitionCounts, previousSlideForCounts.id)
    : null;
  const nextSlideForCounts = currentSlideIndex < slides.length - 1 ? slides[currentSlideIndex + 1] : null;
  const nextTransitionCountsForCurrent = nextSlideForCounts ? getTransitionCounts(transitionCounts, currentSlide.id) : null;

  // Music Anchor v1：現在選択中の構成の「手動」musicAnchor（未設定ならnull＝3章）。
  // Music Anchor Auto Chain v1でも、この変数自体の意味は変えない（1章：slide.musicAnchorは
  // 常に「ユーザーが明示的に指定した基準点＝手動Anchor」を表す。自動計算した位置はここへは
  // 一切保存しない＝2章）。
  const currentMusicAnchor = getMusicAnchor(currentSlide);
  // 絶対秒への変換は常にmusicAnchorToTimeSec()を経由する。Section BPM・countStartSecを
  // 後から変更しても、slide側は書き換えず、この計算結果だけが自動的に新しい値へ追従する
  // （31〜33章）。参照先Sectionが見つからない場合（削除直後の保険）はnullになる。
  const currentMusicAnchorTimeSec = musicAnchorToTimeSec(currentMusicAnchor, musicSections);

  // ==============================================================
  // Music Anchor Auto Chain v1（手動Anchor＋keepCounts＋transitionCountsから後続の音楽位置を自動計算）
  // ==============================================================
  // resolveSlideMusicPosition()はReact stateを一切触らないpure helper（39章）。ここではその結果を
  // useMemoでラップするだけで、自動連鎖の計算ロジック自体はこのフックの外（module scope）に置く
  // （39章：将来のタイムライン表示・PDF出力・musicCurrentTimeからの逆算にも再利用できるようにするため）。
  // 依存配列はslides・musicSections・transitionCounts・currentSlideIndexの4つで、keepCounts変更・
  // transitionCounts変更・構成の追加/削除/並べ替え・手動Anchorの設定/解除のいずれでも自動的に
  // 再計算される（23章：後続slide.musicAnchorを一括書き換えるのではなく、常に派生計算で求める）。
  const resolvedMusicPosition = useMemo(
    () => resolveSlideMusicPosition(slides, currentSlideIndex, musicSections, transitionCounts),
    [slides, currentSlideIndex, musicSections, transitionCounts]
  );
  // 29章：effectiveMusicAnchor。手動Anchorがあれば常にそれを優先し（currentMusicAnchorと同じ値になる）、
  // 無ければresolveSlideMusicPositionの自動計算結果を使う。同期再生・絶対秒表示・warningは、
  // 以後すべてこのeffectiveMusicAnchorを共通で参照する（手動/自動を意識せず扱えるようにするため）。
  const effectiveMusicAnchor = currentMusicAnchor || (resolvedMusicPosition ? resolvedMusicPosition.anchor : null);
  // 現在の構成の音楽位置が「手動」か「自動」かのフラグ。resolvedMusicPosition.isManualと
  // currentMusicAnchorの有無は常に一致する（自分自身に手動Anchorがある場合、
  // resolveSlideMusicPositionは即座にそれをisManual:trueで返すため）。UIの判定にはより直接的な
  // currentMusicAnchorの有無を使う。
  const isMusicAnchorManual = currentMusicAnchor != null;
  // 再生開始モード v1・STEP3・5章：現在構成の再生開始モード表示用。手動Anchorが無い構成では
  // 常に"anchor"（getMusicPlaybackStartMode自体がその場合"anchor"を返すため、ここでは
  // isMusicAnchorManualと組み合わせてUIの表示可否を判定する）。
  const effectiveMusicAnchorTimeSec = musicAnchorToTimeSec(effectiveMusicAnchor, musicSections);
  const effectiveMusicAnchorSection = effectiveMusicAnchor
    ? musicSections.find((s) => s.id === effectiveMusicAnchor.sectionId) || null
    : null;
  // 22章（Music Anchor v1）→ Auto Chain v1では手動/自動どちらの位置にも同じ基準で適用する（11・32章）。
  // 音源durationを超えている場合のwarning判定（作品データは書き換えない＝表示のみ）。
  const musicAnchorDurationWarning =
    effectiveMusicAnchorTimeSec != null &&
    musicMeta.durationSec != null &&
    Number.isFinite(musicMeta.durationSec) &&
    effectiveMusicAnchorTimeSec > musicMeta.durationSec;
  // 次のMusic Section開始秒を超えている場合のwarning判定（11章：自動計算がSectionを勝手に
  // 跨いだ場合も同じ考え方でwarningのみ表示し、自動でSectionを変え直したりはしない）。
  // Sectionの並びはstartSec順で決まる設計（timeSecToSectionPositionと同じ考え方）のため、
  // ここでも並べ替えたコピーで判定する。
  const musicAnchorSectionBoundaryWarning = (() => {
    if (effectiveMusicAnchorTimeSec == null || !effectiveMusicAnchorSection) return false;
    const sorted = [...musicSections].sort((a, b) => (a.startSec || 0) - (b.startSec || 0));
    const idx = sorted.findIndex((s) => s.id === effectiveMusicAnchorSection.id);
    if (idx < 0 || idx >= sorted.length - 1) return false;
    const nextStart = sorted[idx + 1].startSec || 0;
    return effectiveMusicAnchorTimeSec >= nextStart;
  })();

  // ==============================================================
  // Music Sync Playback v1（「現在の構成から、音楽と構成アニメーションを同期して再生」）
  // ==============================================================
  // 今回の目的は「現在選択中の構成から、音楽と構成アニメーションを同期して再生する」ことのみ（v1）。
  // 将来の「musicCurrentTimeを完全なSingle Source of Truthにした全曲・全構成同期」への
  // 布石として、今回追加するstateは最小限（isActive/isPaused/anchorTimeSecの3値）に留め、
  // 既存のanimationState（構成アニメーション）・musicStatus/musicCurrentTime（音楽再生）とは
  // 重複させない（10章）。同期再生専用の新しいアニメーションエンジン・音楽再生エンジンは
  // 一切作らず、既存のdecidePhaseForIndex（連続再生）・startPlaybackFrom（音楽seek+再生開始）・
  // pauseTransition/pauseMusicKeepingPosition（一時停止）・resumeFromPause（再開）・
  // forceIdle（終了）をそのまま呼び出すだけにする（8章・21章：将来設計を邪魔しない）。
  const [syncPlayback, setSyncPlayback] = useState(IDLE_SYNC_PLAYBACK);
  // 連打対策（28章）。setSyncPlayback（Reactのstate更新）の反映を待たず、同じイベントループ内での
  // 連続クリックによる多重start()を防ぐための同期的なガード（animationRef.current.isPlayingと
  // 同じ考え方のrefガード）。
  const syncStartGuardRef = useRef(false);

  // ---- Sync Playback v1.7・PART A：手動Anchor境界が発火しなかった根本原因の修正 ----
  // completeContinuousMove／decidePhaseForIndex／afterKeepForIndex／startMovePhaseContinuousは、
  // どれもApp()本体直下のプレーンな関数宣言であり、連続再生の「keep→move→keep→…」の連鎖は
  // 一度rAFの中で動き出すと、その連鎖が最初にキックされた時点（＝decidePhaseForIndexが
  // 呼ばれた瞬間のレンダー）のクロージャだけをずっと辿り続ける（onCompleteコールバックが
  // runPhase呼び出し時点のクロージャに固定されるため）。
  // 一方、startSyncPlayback()は「setSyncPlayback({isActive:true,...})を呼んだ直後、同じ
  // 同期実行の中でdecidePhaseForIndex()を呼ぶ」という順序になっており、setSyncPlaybackは
  // Reactのstate更新を予約するだけで、そのレンダーのconst syncPlayback自体は古い値
  // （isActive:falseのIDLE_SYNC_PLAYBACK）のままである。そのため、その後ずっと辿られ続ける
  // completeContinuousMove内の `if (syncPlayback.isActive)` は、同期再生セッションが
  // 実際にはアクティブであるにも関わらず、開始時点の古いfalseを永遠に読み続けてしまい、
  // 手動Anchor境界（handleManualAnchorBoundary）が一度も呼ばれない、という不具合の原因だった。
  // 修正方法は、animationRef.current.isPlayingと全く同じ考え方（Reactのstateとは別に、
  // 常に最新値を同期的に読み書きできるrefを1つ用意する）。setSyncPlaybackを直接呼ぶ代わりに
  // 必ずこのapplySyncPlayback()を経由させ、Reactへのstate更新と同時にsyncPlaybackRef.currentも
  // 同期的に更新する。completeContinuousMoveなど「古い世代のクロージャから呼ばれ続ける可能性がある
  // 関数」からは、const syncPlaybackではなくsyncPlaybackRef.currentを読むことで、常に最新の
  // isActive/isPaused/phaseを取得できるようにする。
  const syncPlaybackRef = useRef(IDLE_SYNC_PLAYBACK);
  function applySyncPlayback(updater) {
    const next = typeof updater === "function" ? updater(syncPlaybackRef.current) : updater;
    syncPlaybackRef.current = next;
    setSyncPlayback(next);
  }

  // ---- Music Seek → Formation Reverse Mapping v1・19章 ----
  // 音楽シークで逆算した「今どの構成のkeep/move/prerollのどこにいるか」をUI表示用に
  // 保持するruntime専用state。作品データには一切保存せず（20章：Undo/Redo対象外）、
  // resolveTimelineAtMusicTime()の戻り値をほぼそのまま保持する。
  //   null                         ：seek preview非アクティブ（通常表示）
  //   { found:true, ... }          ：逆算成功。表示自体はcurrentSlideIndex/animationState/
  //                                  scrubProgressへ反映済みのものをそのまま使うため、
  //                                  このstate自体は主にドリフト表示の抑制・状態表示に使う。
  //   { found:false, reason:... }  ：対応する構成が無い（29章）。UIへ小さく警告表示する。
  const [syncSeekPreview, setSyncSeekPreview] = useState(null);

  // ---- 1〜5章：同期再生の開始条件 ----
  // 3章：AudioBufferの有無は、audioBufferRef.current自体（非reactiveなref）ではなく、
  // それと必ず連動して遷移するmusicStatus（"ready"|"playing"|"paused"のときだけ
  // audioBufferRef.currentが必ず入っている＝loadMusicFileのdecode成功直後の代入順序で保証済み）
  // で判定する。新しいstateは増やさない。
  // 4章：絶対秒への変換は、既存のeffectiveMusicAnchor・effectiveMusicAnchorTimeSec（Music Anchor
  // Auto Chain v1で、手動Anchorがあればそれ、無ければresolveSlideMusicPositionの自動計算結果を
  // musicAnchorToTimeSec()へ通した結果として計算済み）をそのまま再利用する。同期再生専用の
  // 秒数計算は一切追加しない。
  // 5章：音源durationを超えている場合は開始不可（既存のmusicAnchorDurationWarningをそのまま利用）。
  // Auto Chain v1・30章：「musicAnchorがnullだからdisabled」という旧判定はやめ、
  // effectiveMusicAnchor（手動 or 自動どちらでも可）が有効かどうかで判定する。
  const hasAudioBufferReady = musicStatus === "ready" || musicStatus === "playing" || musicStatus === "paused";
  // 再生開始モード解決 v1：直接♫▶では、現在構成が「自分自身の」手動Anchorを持ち、
  // かつmusicPlaybackStartMode==="sectionStart"の場合だけ、対応SectionのstartSecから
  // 音楽を先行再生する（resolveMusicPlaybackTimingForSlideへ集約。判定はcurrentSlide自身の
  // getMusicAnchorで行われ、Auto Chainの自動計算結果には適用されない）。それ以外は従来通り
  // getSyncPlaybackTiming相当（effectiveMusicAnchorの絶対時刻から音楽・アニメーションを
  // 同時開始）のまま。秒数計算自体は既存のmusicAnchorToTimeSec()の結果をそのまま使う。
  const syncPlaybackTiming = resolveMusicPlaybackTimingForSlide(
    currentSlide,
    effectiveMusicAnchor,
    effectiveMusicAnchorSection,
    effectiveMusicAnchorTimeSec,
    "direct"
  );
  // 自動イントロ廃止 v1：mode==="anchor"の場合、getSyncPlaybackTiming()は常にprerollSec=0を
  // 返すため、この警告は通常の同期再生ではもう発火しない。mode==="sectionStart"の場合は
  // prerollSecが正の値になり得るが、負になることは無い（getSectionHeadPlaybackTiming側の
  // anchorTimeSec<startSecガードにより、負のprerollSecはnullとして扱われ、この時点で既に
  // 通常のanchor timingへfallback済みのため）。判定式自体はseek等の別経路のために残す
  // （最小変更方針・大規模整理はしない）。
  const musicSectionCountBeforeStartWarning = !!(syncPlaybackTiming && syncPlaybackTiming.prerollSec < 0);
  const syncPlaybackBlockedReason =
    effectiveMusicAnchor == null
      ? "音楽位置が未設定です"
      : effectiveMusicAnchorTimeSec == null
      ? "音楽位置が無効です（参照先のセクションが見つかりません）"
      : !hasAudioBufferReady
      ? "音源が読み込まれていません"
      : musicAnchorDurationWarning
      ? "音楽位置が音源の長さを超えています"
      : musicSectionCountBeforeStartWarning
      ? "カウント開始が楽曲開始より前に設定されているため開始できません"
      : null;
  const canStartSyncPlayback = syncPlaybackBlockedReason == null;

  // ---- Sync Playback v1.6・PART A（1〜6・32章）----
  // 同期一時停止中（isActive && isPaused）は、通常の▶（canPlayTransition）／▶▶（canPlayContinuous）
  // をdisabledにし、♫▶だけを再開の入口にする。canPlayTransition/canPlayContinuous自体
  // （3712/3715行目付近で計算済み、通常再生の可否判定はそのまま）は変更せず、それらへ
  // 「今は同期一時停止中ではない」という条件を掛け合わせただけの別名をCompositionBarへ渡す。
  const syncPlaybackPausedActive = syncPlayback.isActive && syncPlayback.isPaused;
  const canPlayTransitionFinal = canPlayTransition && !syncPlaybackPausedActive;
  const canPlayContinuousFinal = canPlayContinuous && !syncPlaybackPausedActive;
  // Music Seek → Formation Reverse Mapping v1・37章：同期一時停止中は、音楽シークバー側の
  // Reverse Mapping（handleMusicSeekCommit）を優先し、既存の構成スクラバーは無効化する
  // （どちらも最終的にはscrubProgress/animationStateという同じstateへ書き込むため、
  // 両方から同時に触れられると表示が競合するのを避けるため）。canScrub自体（3993行目）は
  // syncPlaybackの宣言より前にあるためここでは変更せず、掛け合わせた別名をJSX側で使う。
  const canScrubFinal = canScrub && !syncPlaybackPausedActive;

  // ---- 6〜13・26・27章：同期再生の開始 ----
  //   1. 既存の単体/連続構成アニメーション（再生中・一時停止中どちらでも）が動いていれば、
  //      forceIdle()で安全に止める（27章。forceIdleはUI専用stateしか触らず作品データには
  //      触れないため、「編集に戻る」と同じ安全な停止方法として再利用する）。
  //   2. 既存の音楽再生（手動再生中も含む）を、既存のstartPlaybackFrom()でtiming.musicStartSecへ
  //      seekしながら再生開始する。startPlaybackFrom内部で必ずstopSourceNode()が呼ばれるため、
  //      SourceNodeが複数同時に鳴ることはない（26章）。
  //   3. 自動イントロ廃止 v1：timing.prerollSecは常に0のため、音楽の再生開始に成功したのと
  //      同じ関数呼び出しの中で、現在の構成から既存の連続再生エンジン（decidePhaseForIndex）を
  //      即座に開始する（＝下のtiming.prerollSec > 0分岐は通常の同期再生ではもう到達しない。
  //      PREROLL_ANIMATION_STATE・プリロール完了監視のuseEffectはseek等の別経路のために
  //      削除せず残す＝最小変更方針）。
  async function startSyncPlayback() {
    if (syncStartGuardRef.current) return; // 連打対策（28章）
    if (!canStartSyncPlayback) return;
    const timing = syncPlaybackTiming;
    if (!timing || timing.musicStartSec == null || timing.animationStartSec == null) return;

    syncStartGuardRef.current = true;
    try {
      if (animationRef.current.isPlaying || animationState.playbackState !== "idle") {
        forceIdle();
      }
      const musicStarted = await startPlaybackFrom(timing.musicStartSec);
      if (!musicStarted) return;
      if (timing.prerollSec > 0) {
        setAnimationState(PREROLL_ANIMATION_STATE);
        applySyncPlayback({ isActive: true, isPaused: false, phase: "preroll", animationStartSec: timing.animationStartSec });
      } else {
        applySyncPlayback({ isActive: true, isPaused: false, phase: "active", animationStartSec: timing.animationStartSec });
        decidePhaseForIndex(currentSlideIndex);
      }
    } finally {
      syncStartGuardRef.current = false;
    }
  }

  // ---- 9〜10章：プリロール完了の監視 ----
  // 新しいrAFは作らず、既存の音楽rAF（startMusicRaf、Web Audio再生位置の表示用）が毎フレーム
  // 更新しているmusicCurrentTimeをそのまま「時計」として使う（10章：SourceNode/rAFの多重生成をしない）。
  // プリロール中（phase==="preroll"）に musicCurrentTime が animationStartSec（＝section.countStartSec）
  // へ到達したら、既存の連続再生エンジン（decidePhaseForIndex）を開始し、phaseを"active"へ切り替える。
  // 一時停止中（isPaused）は音楽のrAF自体が止まっている（musicCurrentTimeが更新されない）ため、
  // この効果は自然に進行しないが、念のため明示的にもガードしておく（15章）。
  useEffect(() => {
    if (!syncPlayback.isActive || syncPlayback.isPaused) return;
    if (syncPlayback.phase !== "preroll") return;
    if (syncPlayback.animationStartSec == null) return;
    if (musicCurrentTime < syncPlayback.animationStartSec) return;
    applySyncPlayback((prev) => (prev.phase === "preroll" ? { ...prev, phase: "active" } : prev));
    decidePhaseForIndex(currentSlideIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncPlayback.isActive, syncPlayback.isPaused, syncPlayback.phase, syncPlayback.animationStartSec, musicCurrentTime]);

  // ---- 11章：同期再生中の一時停止（音楽＋構成の両方を同時に） ----
  // 音楽側はpauseMusicKeepingPosition()（既存の▶/⏸トグルから抽出した共通処理）を常に呼ぶ。
  // 構成側は、プリロール中かどうかで分岐する（15章）：
  //   ・プリロール中：まだ本物のrAF（animationRef.current.isPlaying）が動いていないため、
  //     それを見て早期returnする既存のpauseTransition()は使わず、animationStateだけを
  //     直接「一時停止」表示へ切り替える（構成アニメーション自体はまだ開始していないので、
  //     rAFを止める処理は不要）。
  //   ・プリロール後（通常同期再生中）：従来通り既存のpauseTransition()をそのまま呼ぶ。
  function pauseSyncPlayback() {
    pauseMusicKeepingPosition();
    if (syncPlayback.phase === "preroll") {
      setAnimationState((prev) => ({ ...prev, playbackState: "paused" }));
    } else {
      pauseTransition();
    }
    applySyncPlayback((prev) => (prev.isActive ? { ...prev, isPaused: true } : prev));
  }

  // ---- 12・15・16章：一時停止した同期セッションの再開（音楽＋構成の両方、途中位置から） ----
  // 音楽側は、既存の▶/⏸トグルの「paused状態から再開する」分岐と全く同じ処理
  // （startPlaybackFrom(musicOffsetSecRef.current)）を呼ぶだけで、最初のmusicAnchor位置や
  // section.startSecへは戻さない（16章：musicOffsetSecRefには一時停止時点の位置が
  // pauseMusicKeepingPosition内で既に保存済み）。
  // 構成側は、プリロール中に一時停止したセッションなら、pauseSyncPlaybackと対になる形で
  // animationStateだけを直接「再生中」へ戻す（残りのプリロールは、上のuseEffectが
  // musicCurrentTimeの更新を通じて自動的に継続を検知する）。プリロール後（通常同期再生中）に
  // 一時停止したセッションなら、従来通り既存のresumeFromPause()を呼ぶ。
  async function resumeSyncPlayback() {
    if (!syncPlayback.isActive || !syncPlayback.isPaused) return;
    if (animationRef.current.isPlaying) return; // 連打対策
    if (musicStatus === "paused") {
      await startPlaybackFrom(musicOffsetSecRef.current);
    }
    if (syncPlayback.phase === "preroll") {
      setAnimationState((prev) => ({ ...prev, playbackState: "playing" }));
    } else {
      resumeFromPause();
    }
    applySyncPlayback((prev) => ({ ...prev, isPaused: false }));
    setSyncSeekPreview(null); // 実際に再生を再開したので、seek previewの表示は終了する
  }

  // ---- Music Seek → Formation Reverse Mapping v1 ----
  // 1〜4章：音楽シークバーの「確定」（onPointerUp/onMouseUp/onTouchEnd）から呼ばれる。
  // 通常の音楽seek（handleMusicSeek。onChange＝ドラッグ中も含め毎回呼ばれ、位置の更新だけを行う）
  // とは役割を分け、この関数は「同期一時停止中（isActive && isPaused）」の場合だけ、
  // 現在の音楽位置（musicOffsetSecRef.current。既にhandleMusicSeek側で更新済み）から
  // resolveTimelineAtMusicTime()で構成位置を逆算し、ステージ表示・currentSlideIndex・
  // syncPlaybackへ反映する（3章：通常の音楽再生モードではこの関数は何もしない＝従来通りの
  // 単純な音楽seekのまま）。
  //
  // 22章：音楽側はhandleMusicSeek側で既にoffsetだけが更新済み（一時停止中はstartPlaybackFrom
  // を呼ばないため新しいSourceNodeは鳴らない＝L章のテスト対象）。ここでは構成側の状態だけを
  // 更新する。21章：syncPlayback.isPausedはtrueのまま維持し、ここでは絶対に再生を開始しない。
  //
  // 26章：新しい第二のアニメーションエンジンは作らず、既存のanimationState／scrubProgress／
  // currentSlideIndexという「一時停止中の表示に使われている既存のstate」へ、逆算結果を
  // そのまま書き込むだけに留める。これにより、
  //   ・displayPlacements／displayPlacementsWithScrub（既存のuseMemo、無変更）が
  //     自動的にkeep中は静止表示・move中はinterpolatePlacementsWithPathsによる補間表示を行う（16・17章）
  //   ・実際に♫▶で再開する際は、既存のresumeSyncPlayback→resumeFromPause→runPhaseが
  //     animationStateからそのままstartProgressを読んで残りkeep/moveを再生する（24〜26章）
  // という形で、表示・再開ロジックの二重実装を避けている。
  function handleMusicSeekCommit() {
    if (!(syncPlayback.isActive && syncPlayback.isPaused)) return; // 2・3章：sync一時停止中だけ有効
    const buffer = audioBufferRef.current;
    const rawTimeSec = musicOffsetSecRef.current;
    const timeSec = buffer ? clamp(rawTimeSec, 0, buffer.duration) : rawTimeSec; // 34章

    const result = resolveTimelineAtMusicTime({
      timeSec,
      slides,
      musicSections,
      transitionCounts,
      projectBpm,
    });

    if (!result.found) {
      // 29・30章：対応する構成が無い場合は、前後の構成へ自動吸着せず、今の表示はそのまま維持する。
      setSyncSeekPreview(result);
      return;
    }

    // internalSlideAdvanceRef：completeContinuousMove/handleManualAnchorBoundaryと同じ仕組みで、
    // 「再生エンジン（この場合はseek）自身によるcurrentSlideIndexの変更」であることを示し、
    // すぐ下のuseEffect（[currentSlideIndex]依存）がanimationStateを誤ってidleへリセットしない
    // ようにする。ただし、seek先が既に今のcurrentSlideIndexと同じ場合はindex自体が変化せず
    // そのuseEffect自体が発火しないため、フラグを消費しないまま残してしまわないよう
    // 実際にindexが変わる場合だけ立てる。
    if (result.slideIndex !== currentSlideIndex) {
      internalSlideAdvanceRef.current = true;
    }
    goToSlide(result.slideIndex);

    if (result.phase === "preroll") {
      // 28章：Section startSec〜countStartSecの区間。既存のPREROLL_ANIMATION_STATEと同じ形だが、
      // まだ実際には再生していない（一時停止中の静止表示）ためplaybackStateだけpausedにする。
      setAnimationState({ ...PREROLL_ANIMATION_STATE, playbackState: "paused" });
      setScrubProgress(0);
      applySyncPlayback((prev) => ({
        ...prev,
        phase: "preroll",
        isActive: true,
        isPaused: true, // 21章：seek後も一時停止状態を維持する
        animationStartSec: result.anchorTimeSec,
      }));
    } else if (result.phase === "keep") {
      setAnimationState({
        playbackState: "paused",
        playbackMode: "continuous",
        phase: "keep",
        fromIndex: result.slideIndex,
        toIndex: null,
        progress: result.progress,
      });
      setScrubProgress(0); // keepフェーズはスクラバー対象外（既存の仕様のまま＝17章）
      applySyncPlayback((prev) => ({ ...prev, phase: "active", isActive: true, isPaused: true, animationStartSec: null }));
    } else {
      // phase === "move"：18章の通りfromSlideIndex（=result.slideIndex）をcurrentSlideIndexとして
      // 扱う。displayPlacementsWithScrubは「一時停止中のmoveはscrubProgressで補間表示する」という
      // 既存の仕組みのため、animationState.progressだけでなくscrubProgressも同じ値へ揃える
      // （既存のpauseTransition()が通常のmove一時停止で行っているのと全く同じ対応関係＝16章）。
      setAnimationState({
        playbackState: "paused",
        playbackMode: "continuous",
        phase: "move",
        fromIndex: result.slideIndex,
        toIndex: result.toSlideIndex,
        progress: result.progress,
      });
      setScrubProgress(result.progress);
      applySyncPlayback((prev) => ({ ...prev, phase: "active", isActive: true, isPaused: true, animationStartSec: null }));
    }
    setSyncSeekPreview(result);
  }

  // ---- 17章：一時停止中に「編集に戻る」を押した場合 ----
  // 同期セッションを完全に終了する：構成animation idle（forceIdle）・音楽pause（現在位置のまま。
  // 0秒へは戻さない）・scrubProgress=0（forceIdle内で実施済み）・編集ロック解除
  // （isTransitionActiveがplaybackState==="idle"で自動解除）。work（作品データ）には一切触れない
  // ためUndo履歴は増えない（27章）。forceIdle()はプリロール中の一時停止（synthetic animationState）
  // であっても、IDLE_ANIMATION_STATEへ丸ごとリセットするだけなので、分岐なしでそのまま使える。
  function returnToEditFromSync() {
    if (musicStatus === "playing") {
      pauseMusicKeepingPosition(); // 現在位置で停止するだけ。Anchor秒やsection.startSecへは戻さない
    }
    applySyncPlayback(IDLE_SYNC_PLAYBACK);
    forceIdle();
    setSyncSeekPreview(null); // 36章：reverse preview解除。forceIdle()が既にanimationState/scrubProgress
    // をidleへ戻し、currentSlideIndexに対応する正式なplacementsが自動的に再表示される。
  }

  // ---- 構成バーの⏸・「編集に戻る」を、通常再生と同期再生の両方から共通で使えるようにする「入口」 ----
  // CompositionBarへ渡すonPause/onReturnToEdit自体をこちらに差し替え、通常再生時は今まで通り
  // pauseTransition/returnToEditを呼ぶだけ、同期再生中（syncPlayback.isActive）は上の
  // pauseSyncPlayback/returnToEditFromSyncへ分岐させる（37章：UIのボタン自体は1組のまま、
  // ロジックだけをApp側で振り分ける）。
  function handleCompositionPauseClick() {
    if (syncPlayback.isActive) {
      pauseSyncPlayback();
    } else {
      pauseTransition();
    }
  }
  function handleCompositionReturnToEditClick() {
    if (syncPlayback.isActive) {
      returnToEditFromSync();
    } else {
      returnToEdit();
    }
  }

  // ---- 14・15章：構成の自然終了／音楽の自然終了を、同期セッションの終了へ橋渡しする ----
  // 個々の終了経路（afterKeepForIndexでの連続再生の自然終了、resumeFromPause等のフォールバック、
  // 手動でのスライド変更によるリセットなど）へ同期終了処理を1箇所ずつ埋め込むのではなく、
  // 「animationState.playbackStateがidleへ戻った」という共通の結果だけを監視する1つのeffectに
  // 集約する（経路が増えても同期終了処理を漏れなく1箇所で扱える）。
  useEffect(() => {
    if (!syncPlayback.isActive) return;
    if (animationState.playbackState !== "idle") return; // 一時停止（paused）はここでは何もしない
    if (musicStatus === "playing") {
      pauseMusicKeepingPosition(); // 構成が終了した時点の音楽位置でそのまま止める（14章。0秒へは戻さない）
    }
    applySyncPlayback(IDLE_SYNC_PLAYBACK);
    setSyncSeekPreview(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncPlayback.isActive, animationState.playbackState, musicStatus]);

  // 逆方向（15章）：音楽が先に終了した場合（handleSourceEndedによりmusicStatusが"paused"へ、
  // 位置がduration相当になる）、構成アニメーションがまだ動いている（isAnimationRunning）なら
  // 安全に停止し、同期セッションをidleへ戻す。既に構成側が止まっている場合は上のeffectで
  // 処理済みのため何もしない。
  useEffect(() => {
    if (!syncPlayback.isActive) return;
    if (musicStatus !== "paused") return;
    if (!isAnimationRunning) return;
    forceIdle();
    applySyncPlayback(IDLE_SYNC_PLAYBACK);
    setSyncSeekPreview(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncPlayback.isActive, musicStatus, isAnimationRunning]);

  // ---- 18・19章（Sync Playback v1）→ Auto Chain v1・31章：次slideのeffectiveMusicAnchorとの
  // ズレ検出（自動補正はしない） ----
  // 連続再生中にcurrentSlideIndexが進むと、effectiveMusicAnchor・effectiveMusicAnchorTimeSecは
  // 自動的に「今到達している構成」のものへ切り替わる（手動Anchorの構成に到達すればその値、
  // 自動計算のみの構成に到達すればresolveSlideMusicPositionの結果）。同期再生専用の秒数計算は
  // 追加せず、既に計算済みのeffectiveMusicAnchorTimeSecをそのまま再利用する。
  // deltaがあっても、音楽seekし直す・構成progressを飛ばす・再生速度を変える、といった
  // 自動補正は一切行わない（19章：検出できる構造を用意するところまで）。
  const syncDriftSec =
    syncPlayback.isActive && effectiveMusicAnchor && effectiveMusicAnchorTimeSec != null
      ? musicCurrentTime - effectiveMusicAnchorTimeSec
      : null;
  // Music Seek → Formation Reverse Mapping v1・38章：seek直後は逆算結果に基づいて構成位置を
  // 合わせ直しているだけのため、driftは理論上0付近になり表示してもあまり意味が無い。
  // 既存のsyncDriftSec自体は変更せず、CompositionBarへ渡す直前だけseek preview中は非表示にする。
  const syncDriftSecForDisplay = syncSeekPreview && syncSeekPreview.found ? null : syncDriftSec;

  // Music Timing v1.5・14章：プリロール中かどうか・カウント開始までの残り秒数（UI表示専用の
  // 派生値。work・Undo対象外）。CompositionBarの同期ステータス表示にそのまま渡す。
  const syncPlaybackIsPreroll = syncPlayback.isActive && syncPlayback.phase === "preroll";
  const syncPrerollRemainingSec =
    syncPlaybackIsPreroll && syncPlayback.animationStartSec != null
      ? Math.max(0, syncPlayback.animationStartSec - musicCurrentTime)
      : null;

  // ---- 再生中の音楽位置表示 v1・STEP4・5・7 ----
  // 表示対象は「同期再生active」または「通常アニメーションplaying/paused」のときだけ
  // （isTransitionActiveはanimationState.playbackState!=="idle"のこと。完全idle時は常時表示
  // しない）。同期再生中は実際に鳴っている音楽位置（musicCurrentTime）を正本とし、それ以外の
  // 通常▶/▶▶再生中はresolveAnimationPlaybackMusicTimeSecで求めた仮想絶対秒を使う。
  // 新しい時計・rAF・setIntervalは一切作らず、どちらも既存の値の派生計算のみ（work・schemaへは
  // 一切保存しないUI表示専用の値）。
  const showMusicPlaybackPosition = syncPlayback.isActive || isTransitionActive;
  const currentPlaybackMusicTimeSec = syncPlayback.isActive
    ? musicCurrentTime
    : resolveAnimationPlaybackMusicTimeSec(slides, musicSections, transitionCounts, projectBpm, animationState);
  const musicPlaybackPositionDisplay =
    showMusicPlaybackPosition && currentPlaybackMusicTimeSec != null
      ? getMusicPlaybackPositionDisplay(currentPlaybackMusicTimeSec, musicSections)
      : null;
  const musicPlaybackPositionLabel = formatMusicPlaybackPositionLabel(musicPlaybackPositionDisplay);

  // ＋／−ボタン用：NumberField（ステージ設定の幅・奥行と同じ共通コンポーネント）に
  // そのまま渡せるよう、「クリック後の絶対値」を受け取って1回のcommit（＝1件のUndo履歴）で
  // 反映する形にする（NumberFieldは onButtonChange(value±step) という形で新しい絶対値を渡してくる）。
  // 移動カウント（下限1）とは異なり、キープは「その構成に留まらずすぐ次の移動へ入る」
  // ケースを許容するため下限は0（MIN_KEEP_COUNTS）にする。再生中・一時停止中は変更できない
  // （isTransitionActiveで、途中経過表示中の誤操作を防ぐ＝移動カウントと同じ考え方）。
  const setKeepCountsCommit = useCallback(
    (rawValue) => {
      if (isTransitionActive) return;
      const parsed = Math.round(Number(rawValue));
      const next = Number.isFinite(parsed) ? Math.max(MIN_KEEP_COUNTS, parsed) : MIN_KEEP_COUNTS;
      commitWork((prev) => {
        const idx = prev.currentSlideIndex;
        const slide = prev.slides[idx];
        if (!slide) return prev;
        const cur = typeof slide.keepCounts === "number" ? slide.keepCounts : DEFAULT_KEEP_COUNTS;
        if (next === cur) return prev;
        return {
          ...prev,
          slides: prev.slides.map((s, i) => (i === idx ? { ...s, keepCounts: next } : s)),
        };
      });
    },
    [commitWork, isTransitionActive]
  );

  // ---- 出演者操作 ----
  const addPerformer = () => {
    if (isTransitionActive) return; // 再生中は出演者の追加・削除を無効化
    if (performers.length >= MAX_PERFORMERS) return;
    const nextNumber = performers.length ? Math.max(...performers.map((p) => p.number)) + 1 : 1;
    const id = makeId("performer");
    const color = DEFAULT_COLORS[performers.length % DEFAULT_COLORS.length];
    commitWork((prev) => {
      const zonesNow = computeZones(prev.stage);
      const currentPlacements = prev.slides[prev.currentSlideIndex].placements;
      const pos = findInitialStagePlacement(Object.values(currentPlacements), zonesNow);
      return {
        ...prev,
        performers: [...prev.performers, { id, number: nextNumber, color, height: DEFAULT_PERFORMER_HEIGHT, name: "" }],
        slides: prev.slides.map((s) => ({
          ...s,
          placements: { ...s.placements, [id]: { x: pos.x, y: pos.y, area: "stage" } },
        })),
      };
    });
    setSelectedIds([id]);
  };

  // 出演者一括追加 v1：addPerformer()と全く同じ「番号付与・色割当・id発行・初期placement」の
  // 考え方を、複数人分まとめて1回のcommitWork（＝Undo 1件）で行う。
  // addPerformer()をN回呼ぶ（＝N件のUndo履歴になる）方式は採らず、同じロジックをその場で
  // N人分繰り返してから1回だけcommitする（10章：一括追加1操作＝Undo 1件という要件のため）。
  // number・colorはaddPerformer()と同じく「現在のperformers.length／番号最大値」を起点に、
  // placementはaddPerformer()と同じくfindInitialStagePlacement()を使うが、複数人が同じ座標に
  // 重ならないよう、1人生成するたびにその人のplacementを次の探索対象へ足し込みながら進める。
  const addPerformersBulk = useCallback(
    (count) => {
      if (isTransitionActive) return;
      if (!Number.isInteger(count) || count <= 0) return;
      const allowed = Math.min(count, MAX_PERFORMERS - performers.length);
      if (allowed <= 0) return;

      // number・colorの起点はaddPerformer()と同じ考え方（現在のperformers配列基準）。
      const baseNumber = performers.length ? Math.max(...performers.map((p) => p.number)) + 1 : 1;
      const baseColorIndex = performers.length;
      // idはmakeId()自体が状態非依存（内部カウンタ＋時刻ベース）のため、addPerformer()と同じく
      // commitWork()の外側で先に発行してよい（Reactのバッチ更新・複数回のupdater呼び出しに対しても
      // 常に同じid列を使えるようにするため）。
      const newIds = Array.from({ length: allowed }, () => makeId("performer"));

      commitWork((prev) => {
        const zonesNow = computeZones(prev.stage);
        // addPerformer()と同じく「現在slideのplacements」を起点に空き位置を探索する。
        // 1人追加するたびにその人のplacementをここへ足し込み、次の人の探索に反映することで、
        // 一括追加した人同士が同じ座標へ重ならないようにする。
        let placementsSoFar = { ...prev.slides[prev.currentSlideIndex].placements };
        const newPerformers = newIds.map((id, i) => {
          const pos = findInitialStagePlacement(Object.values(placementsSoFar), zonesNow);
          placementsSoFar = { ...placementsSoFar, [id]: { x: pos.x, y: pos.y, area: "stage" } };
          return {
            id,
            number: baseNumber + i,
            color: DEFAULT_COLORS[(baseColorIndex + i) % DEFAULT_COLORS.length],
            height: DEFAULT_PERFORMER_HEIGHT,
            name: "",
          };
        });
        const addedPlacements = {};
        newPerformers.forEach((p) => {
          addedPlacements[p.id] = placementsSoFar[p.id];
        });
        return {
          ...prev,
          performers: [...prev.performers, ...newPerformers],
          // addPerformer()と同じく、全slideのplacementsへ追加する（単体追加と同じ意味にするため）。
          slides: prev.slides.map((s) => ({
            ...s,
            placements: { ...s.placements, ...addedPlacements },
          })),
        };
      });
      setSelectedIds(newIds);
    },
    [commitWork, isTransitionActive, performers]
  );

  // 出演者の属性（色・身長・番号など）を、指定したid群まとめて更新する汎用ヘルパー。
  // 単独選択（ids=[1件]）にも複数選択の一括変更にもそのまま使える。
  // commit版＝即1件の履歴（プリセット色ボタン・身長ボタンなど離散操作用）、
  // live版＝履歴を増やさない見た目だけの更新（テキスト入力・カラーピッカー用、beginEdit〜endEditと組み合わせる）。
  const applyPerformerPatchCommit = useCallback(
    (ids, patch) => {
      commitWork((prev) => ({
        ...prev,
        performers: prev.performers.map((p) => (ids.includes(p.id) ? { ...p, ...patch } : p)),
      }));
    },
    [commitWork]
  );
  const applyPerformerPatchLive = useCallback(
    (ids, patch) => {
      updateWorkLive((prev) => ({
        ...prev,
        performers: prev.performers.map((p) => (ids.includes(p.id) ? { ...p, ...patch } : p)),
      }));
    },
    [updateWorkLive]
  );
  // 単独選択パネル用のショートハンド（内部的には上の汎用関数を1人分だけ呼ぶ）
  const updatePerformerCommit = useCallback((id, patch) => applyPerformerPatchCommit([id], patch), [applyPerformerPatchCommit]);
  const updatePerformerLive = useCallback((id, patch) => applyPerformerPatchLive([id], patch), [applyPerformerPatchLive]);

  // 姿勢 v1：選択中の出演者（1人・複数どちらも）の姿勢を、現在の構成（slide）のplacementへ
  // まとめて反映する。performer自体ではなくplacement側の属性のため、既存の
  // updateSlidePlacementsCommit（＝現在slideのplacementsだけを1回のcommitWorkで更新する
  // 汎用helper）をそのまま再利用する（3章：既存のcommitWork等の履歴管理方式を再利用）。
  // 複数人を同時に変更しても1回のcommitWork＝Undo 1件（10章の複数選択一括削除等と同じ考え方）。
  const setPerformersPoseCommit = useCallback(
    (ids, pose) => {
      if (isTransitionActive) return;
      if (!ids || ids.length === 0) return;
      updateSlidePlacementsCommit((prev) => {
        const next = { ...prev };
        ids.forEach((id) => {
          if (!next[id]) return; // このslideに配置が無い出演者は対象外（安全側）
          next[id] = { ...next[id], pose };
        });
        return next;
      });
    },
    [updateSlidePlacementsCommit, isTransitionActive]
  );

  // 指定したid群の出演者をまとめて削除する（1回のUndoで全員を復元できるよう1操作でコミット）。
  // 単独削除・複数一括削除のどちらもこの関数を経由する。
  const deletePerformers = useCallback(
    (ids) => {
      if (isTransitionActive) return; // 再生中は出演者の追加・削除を無効化
      if (!ids.length) return;
      commitWork((prev) => ({
        ...prev,
        performers: prev.performers.filter((p) => !ids.includes(p.id)),
        slides: prev.slides.map((s) => {
          const next = { ...s.placements };
          ids.forEach((id) => delete next[id]);
          return { ...s, placements: next };
        }),
      }));
      setSelectedIds((prev) => prev.filter((x) => !ids.includes(x)));
    },
    [commitWork, isTransitionActive]
  );
  const deletePerformer = useCallback((id) => deletePerformers([id]), [deletePerformers]);

  // ==============================================================
  // Keyboard Editing v1 PART B：Delete / Backspaceによる削除（優先順位付きディスパッチ）
  // ==============================================================
  // 17章の優先順位をそのまま実装する：
  //   1. 出演者が1人以上選択されている → 選択中の出演者を削除
  //        - 1人選択（18章）：既存の単独削除（deletePerformer。確認モーダルなし＝既存仕様通り）をそのまま再利用
  //        - 複数選択（19章）：既存の一括削除確認モーダル（bulkDeleteConfirmOpen→confirm時にdeletePerformers）を
  //          そのまま再利用する。ここでは開くだけにし、実際の削除は既存のConfirmDeleteModalのonConfirmに任せる
  //          （キーボード専用の削除ロジックを二重実装しない＝19章）。
  //   2. 出演者が1人も選択されていない → 現在の構成を削除（20〜22章、requestDeleteCurrentSlideByKeyboard経由）。
  // 再生中・一時停止中は無効化する（28〜29章：「編集に戻る」後にのみ有効）。
  const handleDeleteKeyPress = useCallback(() => {
    if (isTransitionActive) return;
    if (selectedIds.length === 1) {
      deletePerformer(selectedIds[0]);
    } else if (selectedIds.length >= 2) {
      setBulkDeleteConfirmOpen(true);
    } else {
      requestDeleteCurrentSlideByKeyboard();
    }
  }, [isTransitionActive, selectedIds, deletePerformer, requestDeleteCurrentSlideByKeyboard]);

  // ==============================================================
  // キーボードショートカット統合：Undo/Redo・ズーム・Keyboard Editing v1
  // ==============================================================
  // TDZ修正メモ：このuseEffectは元々App()の先頭付近（selectedIds・slidesの直後）に
  // 置かれていたが、依存配列 [..., isTransitionActive, copyCurrentSlide, pasteCopiedSlide,
  // handleDeleteKeyPress] はuseEffect呼び出し自体の引数として「render中に同期的に評価される
  // 通常のJS配列リテラル」であり、これらのconstがこの位置より後（isTransitionActiveは
  // animationState定義の下、copyCurrentSlide/pasteCopiedSlide/handleDeleteKeyPressは
  // さらにそのあと）で初めて初期化されるため、"Cannot access '...' before initialization"
  // というTDZ（Temporal Dead Zone）エラーになっていた。
  // ※ハンドラ「本体」（handleKeyDown関数の中身）は実際のkeydownイベント発火時まで実行されない
  //   ため、後方のconstをクロージャ経由で参照するだけなら問題ない（animationRef.current.isPlaying
  //   がそうしているように）。問題になるのはあくまで依存配列という「即時評価される値」の方だけ。
  // 修正方法：このuseEffect自体を、参照する全てのconst／useCallback（isTransitionActive・
  // copyCurrentSlide・pasteCopiedSlide・handleDeleteKeyPress。selectedIds・slidesはこれより
  // 前で定義済みなので元々問題なし）が実際に定義された後の位置（＝ここ）へそのまま移動した。
  // Hooksの呼び出し自体は変わらず毎レンダー無条件に1回だけ実行されるため、Hooksの規則
  // （呼び出し順序を条件分岐に入れない）には抵触しない。新しいstate／refは追加していない。
  //
  // Undo/Redo（Command/Ctrl+Z、Command/Ctrl+Shift+Z、Ctrl+Y）、
  // ズームのキーボードショートカット（+ / = で拡大、− で縮小、0 で100%に戻す）、
  // および Keyboard Editing v1（構成Copy/Paste・Delete/Backspaceによる削除）を、
  // すべてこの1つのkeydown listenerへまとめる（31章：新しいlistenerを無計画に追加しない）。
  // Undo/Redoは「入力欄を編集中でも」アプリ全体の履歴操作として動作させる。
  // （その際、編集中の入力欄があれば先にblurして進行中の入力を1件の履歴として確定してから
  //   Undo/Redoを実行することで、履歴の整合性を保つ。）
  // ズーム・構成Copy/Paste・Delete/Backspaceは、従来通り入力欄操作中は発動しない
  // （isEditableTargetでガード＝25〜27章）。
  // いずれもブラウザ標準の動作と競合しないよう、実際に処理した場合のみ preventDefault する（33章）。
  // isTransitionActiveは「再生中・一時停止中の両方」でtrueになる値（animationState.playbackState
  // !== "idle"）なので、これをそのまま使うことで「一時停止中もCopy/Paste/Delete/Backspaceを
  // ロックし、『編集に戻る』を押した後（＝idleに戻った後）にのみ有効化する」仕様（4章・28〜29章）を
  // 引き続き満たす。
  useEffect(() => {
    const isMac = typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent || navigator.platform || "");
    const handleKeyDown = (e) => {
      const target = e.target;
      const isEditable = isEditableTarget(target);
      const mod = isMac ? e.metaKey : e.ctrlKey;

      // Undo / Redo（入力欄フォーカス中でも発動する）。ただし構成間移動アニメーションの
      // 再生中は作品データ（work）を書き換える操作のため無効化する。
      // animationRef.current.isPlaying は「実際にrAFで進行中」だけを表す値で、参照先の
      // animationRefがrefであるため元々TDZの心配はない（このuseEffectの位置に関わらず安全）。
      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (animationRef.current.isPlaying) return;
        if (isEditable && typeof target.blur === "function") target.blur();
        if (e.shiftKey) redoWork();
        else undoWork();
        return;
      }
      if (mod && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        if (animationRef.current.isPlaying) return;
        if (isEditable && typeof target.blur === "function") target.blur();
        redoWork();
        return;
      }

      // ここから下（ズーム・構成Copy/Paste・Delete/Backspace）は、入力欄フォーカス中は
      // 一切発動しない（25章：最重要。構成名・BPM・Music SectionのstartSec等のinput中は、
      // Backspaceでの文字削除やCommand/Ctrl+C/Vでのテキストコピー＆ペーストをブラウザ標準のまま
      // 動かす＝isEditableTargetの判定さえ通れば、これより下は一切見ない）。
      if (isEditable) return;

      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomBy(ZOOM_STEP);
        return;
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomBy(-ZOOM_STEP);
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        resetZoomTo100();
        return;
      }

      // ---- Keyboard Editing v1 PART A：構成Copy（Command/Ctrl+C） ----
      // 34章：「Command+Cは何でも構成コピー」と決め打ちにせず、selectedIds.length===0の
      // 場合だけを対象にする（出演者選択中は将来の出演者コピーのため今回は何もしない＝14章）。
      // copyCurrentSlide自体もisTransitionActive・selectedIdsを再チェックする（防御的二重チェック）。
      if (mod && (e.key === "c" || e.key === "C")) {
        const willHandle = !isTransitionActive && selectedIds.length === 0;
        if (willHandle) e.preventDefault(); // 33章：実際に処理する場合のみ。処理しない場合はブラウザ標準コピーを維持する
        copyCurrentSlide();
        return;
      }

      // ---- Keyboard Editing v1 PART A：構成Paste（Command/Ctrl+V） ----
      // 15章：出演者選択中はPasteもしない。12章：clipboard未設定でもクラッシュしない
      // （pasteCopiedSlide内部でcopiedSlideRef.current有無をチェック済み）。
      if (mod && (e.key === "v" || e.key === "V")) {
        const willHandle = !isTransitionActive && selectedIds.length === 0 && !!copiedSlideRef.current;
        if (willHandle) e.preventDefault();
        pasteCopiedSlide();
        return;
      }

      // ---- Keyboard Editing v1 PART B：Delete / Backspaceによる削除 ----
      // 17章の優先順位はhandleDeleteKeyPress側に集約済み（出演者選択中は出演者削除、
      // 未選択なら構成削除）。ここでは28〜29章の再生中ロックと、33章のpreventDefault方針
      // （実際に何か削除される場合だけpreventDefaultする。最後の1構成で構成削除が
      //   何も起きないケースでは、ブラウザ標準動作を維持する）だけを担当する。
      if (e.key === "Delete" || e.key === "Backspace") {
        if (isTransitionActive) return;
        const willHandle = selectedIds.length > 0 || slides.length > 1;
        if (willHandle) e.preventDefault();
        handleDeleteKeyPress();
        return;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // animationRef はrefのため依存配列に含める必要はない（常に最新のcurrentを参照できるため）
  }, [
    zoomBy,
    resetZoomTo100,
    undoWork,
    redoWork,
    isTransitionActive,
    selectedIds,
    slides.length,
    copyCurrentSlide,
    pasteCopiedSlide,
    handleDeleteKeyPress,
  ]);

  // 座標を設定すると同時に、そこがどのエリア（ステージ／下手袖／上手袖／舞台奥待機）かを
  // 自動で判定して area に保存する。将来の移動アニメーションでも同じ関数を経由すれば
  // 常に area が座標と矛盾しない状態に保てる。commit版は即1件の履歴、live版は
  // beginEdit〜endEdit（フォーカス〜blur/Enter）で囲んで使う。
  const setPlacementCommit = useCallback(
    (id, x, y, snap) => {
      if (isTransitionActive) return; // 再生中は座標入力を無効化
      const finalX = snap ? snapPlacementCoordinate(x) : x;
      const finalY = snap ? snapPlacementCoordinate(y) : y;
      updateSlidePlacementsCommit((prev, prevWork) => {
        const zonesNow = computeZones(prevWork.stage);
        const resolved = resolveArea({ x: finalX, y: finalY }, zonesNow);
        const area = resolved || (prev[id] && prev[id].area) || "stage";
        return { ...prev, [id]: { ...prev[id], x: finalX, y: finalY, area } };
      });
    },
    [updateSlidePlacementsCommit, isTransitionActive]
  );
  const setPlacementLive = useCallback(
    (id, x, y, snap) => {
      if (isTransitionActive) return; // 再生中は座標入力を無効化
      const finalX = snap ? snapPlacementCoordinate(x) : x;
      const finalY = snap ? snapPlacementCoordinate(y) : y;
      updateSlidePlacementsLive((prev, prevWork) => {
        const zonesNow = computeZones(prevWork.stage);
        const resolved = resolveArea({ x: finalX, y: finalY }, zonesNow);
        const area = resolved || (prev[id] && prev[id].area) || "stage";
        return { ...prev, [id]: { ...prev[id], x: finalX, y: finalY, area } };
      });
    },
    [updateSlidePlacementsLive, isTransitionActive]
  );

  const returnToStage = (id) => {
    const pos = placements[id];
    if (!pos) return;
    const halfW = stage.width / 2;
    setPlacementCommit(id, clamp(pos.x, -halfW, halfW), clamp(pos.y, 0, stage.depth), true);
  };

  const returnAllToStage = () => {
    if (isTransitionActive) return; // 再生中は座標入力を無効化
    const halfW = stage.width / 2;
    updateSlidePlacementsCommit((prev, prevWork) => {
      const zonesNow = computeZones(prevWork.stage);
      const next = { ...prev };
      performers.forEach((p) => {
        const pos = next[p.id];
        if (pos && isBeyondAllAreas(pos, zonesNow)) {
          next[p.id] = {
            ...pos,
            x: clamp(pos.x, -halfW, halfW),
            y: clamp(pos.y, 0, stage.depth),
            area: "stage",
          };
        }
      });
      return next;
    });
  };

  // 選択中の複数出演者を、つかんだ人からの相対移動量(dx, dy)を保ったまま一括移動する。
  // TopView から呼ばれ、ドラッグ中は常に見た目だけの更新（履歴を増やさない）。
  // pointerdown で onDragStart（beginWorkBatch）、pointerup で onDragEnd（endWorkBatch）を
  // 呼ぶことで、ドラッグ全体（単独でも複数人一括でも）を1件の履歴としてまとめる。
  const dragGroup = useCallback(
    (ids, dx, dy, initialPositions, snap) => {
      if (isTransitionActive) return; // 再生中は出演者のドラッグを無効化
      updateSlidePlacementsLive((prev, prevWork) => {
        const zonesNow = computeZones(prevWork.stage);
        const next = { ...prev };
        ids.forEach((id) => {
          const init = initialPositions[id];
          if (!init) return;
          let nx = init.x + dx;
          let ny = init.y + dy;
          if (snap) {
            nx = snapPlacementCoordinate(nx);
            ny = snapPlacementCoordinate(ny);
          }
          const resolved = resolveArea({ x: nx, y: ny }, zonesNow);
          const area = resolved || (prev[id] && prev[id].area) || "stage";
          next[id] = { ...next[id], x: nx, y: ny, area };
        });
        return next;
      });
    },
    [updateSlidePlacementsLive, isTransitionActive]
  );
  const handleDragStart = useCallback(() => beginWorkBatch(), [beginWorkBatch]);
  const handleDragEnd = useCallback(() => endWorkBatch(), [endWorkBatch]);

  // 右パネルの「エリア」プルダウンから呼ばれる、エリアのクイック変更（即1件の履歴）。
  // 1人でも複数人でも使える：対象を番号順に並べ替え、移動先エリアの中央付近に
  // 0.5単位で重ならないよう並べる（並べたあとは通常通り手動で微調整できる）。
  const moveIdsToArea = useCallback(
    (ids, areaKey) => {
      if (isTransitionActive) return; // 再生中は座標（エリア）入力を無効化
      if (!ids.length || !AREA_LABELS[areaKey]) return;
      const sortedIds = [...ids].sort((a, b) => {
        const pa = performers.find((p) => p.id === a);
        const pb = performers.find((p) => p.id === b);
        return (pa ? pa.number : 0) - (pb ? pb.number : 0);
      });
      updateSlidePlacementsCommit((prev, prevWork) => {
        const zonesNow = computeZones(prevWork.stage);
        const positions = arrangeInZone(sortedIds, areaKey, zonesNow);
        const next = { ...prev };
        sortedIds.forEach((id) => {
          const pos = positions[id];
          if (!pos) return;
          next[id] = { ...next[id], x: pos.x, y: pos.y, area: areaKey };
        });
        return next;
      });
    },
    [performers, updateSlidePlacementsCommit, isTransitionActive]
  );

  // 複数選択時の座標一括入力（横位置／縦位置）。指定した軸だけを全員に反映し、
  // もう一方の軸は各自の値を維持する。入力中はlive更新のみ、確定時（blur/Enter）に
  // beginEdit〜endEditで1件の履歴としてまとめる。
  const applyBulkAxisLive = useCallback(
    (ids, axis, rawValue) => {
      if (isTransitionActive) return; // 再生中は座標入力を無効化
      const snapped = snapPlacementCoordinate(rawValue);
      updateSlidePlacementsLive((prev, prevWork) => {
        const zonesNow = computeZones(prevWork.stage);
        const next = { ...prev };
        ids.forEach((id) => {
          const pos = next[id];
          if (!pos) return;
          const nx = axis === "x" ? snapped : pos.x;
          const ny = axis === "y" ? snapped : pos.y;
          const resolved = resolveArea({ x: nx, y: ny }, zonesNow);
          const area = resolved || pos.area || "stage";
          next[id] = { ...pos, x: nx, y: ny, area };
        });
        return next;
      });
    },
    [updateSlidePlacementsLive, isTransitionActive]
  );

  const selectedPerformer = selectedIds.length === 1 ? performers.find((p) => p.id === selectedIds[0]) || null : null;
  const selectedPos = selectedPerformer ? placements[selectedPerformer.id] : null;
  const isMultiSelect = selectedIds.length > 1;

  const halfW = stage.width / 2;

  // ==============================================================
  // Multi Project / Workspace v1（続き）：同期・自動保存・Project操作
  // ==============================================================

  // work（useHistoryStateの現在値）→ workspace.projects[activeProjectId].work への一方向同期。
  // 29章「二重管理しない」の要件を、常にworkが正・workspace側はそれをミラーするだけの
  // 一方向コピーにすることで満たす（workspace側を書き換えてもworkは再生成されない＝
  // 唯一workを書き換えられるのはcommitWork/updateWorkLive/resetWorkだけ）。
  // mergeWorkIntoWorkspace()に集約したことで、Project切替直前にも同じロジックで明示的に
  // 書き戻せるようになっている（Project別音源管理v1：直前に読み込んだmusicAssetの参照が
  // 取りこぼされないようにするため）。
  useEffect(() => {
    setWorkspace((prevWs) => mergeWorkIntoWorkspace(prevWs, prevWs.activeProjectId, work));
  }, [work]);

  // Workspace変更のたびにlocalStorageへ自動保存する（16章）。animation progress・
  // musicCurrentTime・zoom/pan・モーダル開閉等のruntime/UI stateはそもそもworkspace
  // stateに含まれていないため、ここで保存されるのは常に「Project一覧＋各Projectのwork」
  // だけになる（構造的に17章の要件を満たす）。setItem失敗（容量超過等）はsaveWorkspace内で
  // try/catch済みで、アプリはクラッシュしない（21章）。WAV本体はここには一切含まれない
  // （work.project.musicAssetは{id, fileName, mimeType}という参照情報のみ＝Project別音源管理v1）。
  //
  // 自動保存の実用化・PART E：保存中／保存済み／保存に失敗をヘッダーへ小さく表示するため、
  // saveWorkspace()の成否をsaveStatusへ反映する。既存のdebounce（300ms・PART C要件の
  // 300〜800msの範囲内なのでそのまま再利用）・try/catch方針は一切変更しない。
  const autosaveTimerRef = useRef(null);
  const [saveStatus, setSaveStatus] = useState("saved"); // "saving" | "saved" | "error"
  // 初回マウント時（loadWorkspace()の結果をそのままsetWorkspaceした直後）は「編集した」わけ
  // ではないため、「保存中…」を一瞬表示させるチラつきを避ける（まだ何も編集していない状態で
  // 保存中表示が出るのは不自然なため）。
  const isFirstWorkspaceEffectRef = useRef(true);
  useEffect(() => {
    if (isFirstWorkspaceEffectRef.current) {
      isFirstWorkspaceEffectRef.current = false;
      return;
    }
    setSaveStatus("saving");
    if (autosaveTimerRef.current != null) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      const ok = saveWorkspace(workspace);
      setSaveStatus(ok ? "saved" : "error");
      if (!ok) {
        console.warn("[Workspace] localStorageへの自動保存に失敗しました（容量超過や非対応環境の可能性があります）。");
      }
    }, 300);
    return () => {
      if (autosaveTimerRef.current != null) clearTimeout(autosaveTimerRef.current);
    };
  }, [workspace]);

  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [projectRenamingId, setProjectRenamingId] = useState(null);
  const [projectDeleteTargetId, setProjectDeleteTargetId] = useState(null);

  // Project Backup v1：書き出し／読み込みの結果案内・エラー表示用state。
  // 通常のエラー表示（pngExportError等）と同じ考え方で、専用モーダル1つだけに集約する
  // （新しいトースト通知基盤等は追加しない）。
  const [projectBackupMessage, setProjectBackupMessage] = useState(null); // { tone: "error"|"notice", text }
  const importFileInputRef = useRef(null);

  // Project切替前の共通cleanup：再生中なら停止し、構成間アニメーション・Sync Playbackの
  // runtimeを安全にresetする（19章）。work自体（project.bpm・musicSectionsなど）には
  // 一切触れない。音源のcleanup/復元はここでは行わない（restoreMusicForProjectへ分離済み・
  // Project別音源管理v1の5章：「runtimeを止めること」と「音源を復元/削除すること」を分離する）。
  const stopRuntimeForProjectSwitch = useCallback(() => {
    forceIdle();
    setSyncPlayback(IDLE_SYNC_PLAYBACK);
  }, []);

  // ページ初回読み込み時に一度だけ、activeProjectの音源をIndexedDBから自動復元する（11章）。
  // Workspace自体はuseState初期化時（loadWorkspace()）に既に同期的復元済みのため、
  // ここでは「audio runtimeだけ」を追いかけて復元すればよい。
  const initialMusicRestoreDoneRef = useRef(false);
  useEffect(() => {
    if (initialMusicRestoreDoneRef.current) return;
    initialMusicRestoreDoneRef.current = true;
    restoreMusicForProject(activeProject);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 指定したProjectへ切替える。currentSlideIndexを新workの構成数に合わせて安全な範囲へ
  // clampし（6章）、Undo/Redo履歴はProject切替のたびに必ずリセットする（13章の設計判断：
  // 「Project AでUndoしたらProject Bが変わる」事故を防ぐため、v1ではProjectごとの履歴を
  // 持たず、切替時resetを採用した）。
  // 音源は、切替先Projectのwork.project.musicAssetを見てIndexedDBから非同期に復元する
  // （restoreMusicForProject。Project別音源管理v1・5章の1〜10ステップ）。
  const switchProject = useCallback(
    (projectId) => {
      if (isTransitionActive) return; // 20章：再生中・一時停止中はProject切替不可
      if (projectId === workspace.activeProjectId) {
        setProjectMenuOpen(false);
        return;
      }
      const target = workspace.projects.find((p) => p.id === projectId);
      if (!target) return;
      stopRuntimeForProjectSwitch();
      setSelectedIds([]);
      setViewState({ topView: { ...DEFAULT_VIEW_STATE }, audienceView: { ...DEFAULT_VIEW_STATE } });
      resetWork(clampWorkSlideIndex(target.work));
      setWorkspace((prevWs) => {
        const merged = mergeWorkIntoWorkspace(prevWs, prevWs.activeProjectId, work);
        return { ...merged, activeProjectId: projectId };
      });
      restoreMusicForProject(target);
      setProjectMenuOpen(false);
    },
    [isTransitionActive, workspace.activeProjectId, workspace.projects, stopRuntimeForProjectSwitch, resetWork, work, restoreMusicForProject]
  );

  // 新規Project作成。既存の新規作品仕様と完全に一致させるため、createInitialWork()
  // （＝旧initialWorkRef.currentの中身と同一）をそのまま再利用する（7章）。
  // createInitialWork()はmusicAsset: nullを持つため、restoreMusicForProjectを呼んでも
  // 実質removeMusic()相当（＝直前Projectの音源を引き継がない＝6章）で終わる。
  const createNewProject = useCallback(() => {
    if (isTransitionActive) return;
    const name = `プロジェクト ${workspace.projects.length + 1}`;
    const newProject = createProjectFromWork(createInitialWork(), name);
    stopRuntimeForProjectSwitch();
    setSelectedIds([]);
    setViewState({ topView: { ...DEFAULT_VIEW_STATE }, audienceView: { ...DEFAULT_VIEW_STATE } });
    resetWork(newProject.work);
    setWorkspace((prevWs) => {
      const merged = mergeWorkIntoWorkspace(prevWs, prevWs.activeProjectId, work);
      return { ...merged, projects: [...merged.projects, newProject], activeProjectId: newProject.id };
    });
    restoreMusicForProject(newProject);
    setProjectMenuOpen(false);
  }, [isTransitionActive, workspace.projects.length, stopRuntimeForProjectSwitch, resetWork, work, restoreMusicForProject]);

  // 現在Projectの複製（deep copy）。JSON.parse(JSON.stringify(...))は、work内が
  // stage/performers/slides/transitionCounts/transitionPaths/project（bpm・musicSections・
  // musicAsset）という「プレーンなJSON化可能データ」だけで構成されていることが前提だが、
  // Workspace自体をlocalStorageへ保存できている時点でこの前提は常に満たされている（17章）。
  // Project IDは新規発行するが、内部のperformer.id/slide.id等は再発行しない（10章）。
  // musicAssetの参照（assetId）もそのままdeep copyされるため、複製ProjectはIndexedDB内の
  // 同じ音源Blobを共有参照する（7章：WAV実体をIndexedDB内で二重保存しない）。
  // 複製直後は複製Projectへ自動的に切替える（27章のユースケースに合わせる）。
  const duplicateProject = useCallback(
    (projectId) => {
      if (isTransitionActive) return;
      const source = workspace.projects.find((p) => p.id === projectId);
      if (!source) return;
      const copiedWork = JSON.parse(JSON.stringify(source.work));
      const newProject = createProjectFromWork(copiedWork, `${source.name} のコピー`);
      stopRuntimeForProjectSwitch();
      setSelectedIds([]);
      setViewState({ topView: { ...DEFAULT_VIEW_STATE }, audienceView: { ...DEFAULT_VIEW_STATE } });
      resetWork(clampWorkSlideIndex(newProject.work));
      setWorkspace((prevWs) => {
        const merged = mergeWorkIntoWorkspace(prevWs, prevWs.activeProjectId, work);
        return { ...merged, projects: [...merged.projects, newProject], activeProjectId: newProject.id };
      });
      restoreMusicForProject(newProject);
      setProjectMenuOpen(false);
    },
    [isTransitionActive, workspace.projects, stopRuntimeForProjectSwitch, resetWork, work, restoreMusicForProject]
  );

  // Project名の変更。空文字で確定した場合は「名称未設定」にフォールバックする（8章）。
  const renameProject = useCallback((projectId, rawName) => {
    const trimmed = typeof rawName === "string" ? rawName.trim() : "";
    const nextName = trimmed || "名称未設定";
    setWorkspace((prevWs) => {
      const idx = prevWs.projects.findIndex((p) => p.id === projectId);
      if (idx === -1) return prevWs;
      const nextProjects = prevWs.projects.slice();
      nextProjects[idx] = { ...nextProjects[idx], name: nextName, updatedAt: new Date().toISOString() };
      return { ...prevWs, projects: nextProjects };
    });
  }, []);

  // Project削除の実行本体（確認モーダルのonConfirmから呼ばれる）。最後の1件は削除不可（11章）。
  // activeだったProjectを削除した場合は、直前のProject（無ければ先頭）へ安全に切替え、
  // そのProjectの音源をrestoreMusicForProjectで復元する（K）。
  // 削除するProjectが参照していたmusicAssetは、他のどのProjectからも参照されなくなった
  // 場合にだけIndexedDBから削除する（8章：参照カウントは持たず、その場でWorkspaceを走査して判定）。
  const deleteProject = useCallback(
    (projectId) => {
      if (workspace.projects.length <= 1) {
        setProjectDeleteTargetId(null);
        return;
      }
      const idx = workspace.projects.findIndex((p) => p.id === projectId);
      if (idx === -1) return;
      const target = workspace.projects[idx];
      const targetAsset = getMusicAsset(target.work);
      const nextProjects = workspace.projects.slice(0, idx).concat(workspace.projects.slice(idx + 1));
      const wasActive = workspace.activeProjectId === projectId;
      const fallback = wasActive ? nextProjects[idx - 1] || nextProjects[0] : null;

      if (wasActive && fallback) {
        stopRuntimeForProjectSwitch();
        setSelectedIds([]);
        setViewState({ topView: { ...DEFAULT_VIEW_STATE }, audienceView: { ...DEFAULT_VIEW_STATE } });
        resetWork(clampWorkSlideIndex(fallback.work));
        restoreMusicForProject(fallback);
      }

      setWorkspace((prevWs) => {
        const pIdx = prevWs.projects.findIndex((p) => p.id === projectId);
        if (pIdx === -1 || prevWs.projects.length <= 1) return prevWs;
        const nextP = prevWs.projects.slice(0, pIdx).concat(prevWs.projects.slice(pIdx + 1));
        let nextActiveId = prevWs.activeProjectId;
        if (prevWs.activeProjectId === projectId) {
          nextActiveId = (nextP[pIdx - 1] || nextP[0]).id;
        }
        return { ...prevWs, projects: nextP, activeProjectId: nextActiveId };
      });

      if (targetAsset) {
        const stillReferenced = isMusicAssetReferencedByAnyProject(workspace, targetAsset.id, projectId);
        if (!stillReferenced) {
          idbDeleteMusicAsset(targetAsset.id).catch(() => {});
        }
      }

      setProjectDeleteTargetId(null);
      setProjectMenuOpen(false);
    },
    [workspace, stopRuntimeForProjectSwitch, resetWork, restoreMusicForProject]
  );

  // Project Backup v1・書き出し：現在のactive Project（＝現在編集中のwork）をBackup JSONへ
  // まとめ、既存のdownloadBlob()を使って1ファイルとしてダウンロードする。ExportはUndo対象外・
  // Workspace/workへは一切書き込まない（18章）。
  const handleExportProjectBackup = useCallback(() => {
    setProjectMenuOpen(false);
    try {
      const backup = buildProjectBackup(activeProject.name, work);
      const json = JSON.stringify(backup, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const filename = `${sanitizeExportFilenameName(activeProject.name) || "project"}.json`;
      downloadBlob(blob, filename, (err) => {
        console.error("[ProjectBackup] export failed", err);
        setProjectBackupMessage({ tone: "error", text: "プロジェクトの書き出しに失敗しました。" });
      });
    } catch (err) {
      console.error("[ProjectBackup] export failed", err);
      setProjectBackupMessage({ tone: "error", text: "プロジェクトの書き出しに失敗しました。" });
    }
  }, [activeProject.name, work]);

  // Project Backup v1・読み込み：「プロジェクトを読み込む」から隠しfile inputのclick()を
  // 呼び出すだけのトリガー。実際の読み込み処理はhandleImportFileSelectedへ委譲する。
  const triggerImportProjectBackup = useCallback(() => {
    setProjectMenuOpen(false);
    if (importFileInputRef.current) {
      importFileInputRef.current.value = "";
      importFileInputRef.current.click();
    }
  }, []);

  // 選択された.jsonファイルを読み込み、検証したうえで「必ず新しいProjectとして」
  // Workspaceへ追加する（13章：現在Projectを絶対に上書きしない）。
  // 失敗時（壊れたJSON・backupType不一致・version不一致・project.work欠損等）は、
  // Workspaceを一切変更せず、エラーだけを案内する（23章）。
  const handleImportFileSelected = useCallback(
    async (e) => {
      const file = e.target.files && e.target.files[0];
      if (e.target) e.target.value = ""; // 同じファイルを連続で選び直せるようにする
      if (!file) return;
      if (isTransitionActive) {
        setProjectBackupMessage({ tone: "error", text: "再生中はプロジェクトを読み込めません。停止してから再度お試しください。" });
        return;
      }

      let text;
      try {
        text = await file.text();
      } catch (err) {
        setProjectBackupMessage({ tone: "error", text: "ファイルを読み込めませんでした。" });
        return;
      }

      let raw;
      try {
        raw = JSON.parse(text);
      } catch (err) {
        setProjectBackupMessage({ tone: "error", text: "壊れたJSONファイルのようです。読み込みを中止しました。" });
        return;
      }

      const validated = validateProjectBackup(raw);
      if (!validated.ok) {
        setProjectBackupMessage({ tone: "error", text: `${validated.reason} 読み込みを中止しました。` });
        return;
      }

      // musicAsset参照はJSONそのまま保持してImportする（6章：assetIdの再発行・Blobコピーは
      // 不要。元Projectと同じassetIdを複数Projectが参照できる既存の参照共有設計をそのまま使う）。
      // 「IndexedDBに実際のBlobが残っているか」は、ここで別途idbGetMusicAsset()を呼んで
      // 事前確認しない。restoreMusicForProject()が内部で1回だけIndexedDBへアクセスし、その
      // 結果（返り値のstatus）をそのまま使う。Project切替（switchProject）と全く同じ回数・
      // 同じタイミングでしかIndexedDBへアクセスしないようにすることで、Import時にだけ余分な
      // IndexedDB接続が増えることによる問題（Safariでの音源runtime破損の原因だった）を避ける。
      const newName = buildImportedProjectName(workspace.projects, validated.name);
      // project.idだけ新規発行し、slide.id / performer.id / transitionCounts /
      // transitionPaths等の内部idはそのまま保持する（14章：内部参照関係を壊さないため）。
      const newProject = createProjectFromWork(validated.work, newName);

      stopRuntimeForProjectSwitch();
      setSelectedIds([]);
      setViewState({ topView: { ...DEFAULT_VIEW_STATE }, audienceView: { ...DEFAULT_VIEW_STATE } });
      resetWork(clampWorkSlideIndex(newProject.work));
      setWorkspace((prevWs) => {
        const merged = mergeWorkIntoWorkspace(prevWs, prevWs.activeProjectId, work);
        return { ...merged, projects: [...merged.projects, newProject], activeProjectId: newProject.id };
      });
      // switchProject()と同様、ここではawaitせず呼び出すだけでも動作はするが、Import直後に
      // 表示する案内メッセージ（音源復元の成否）を出し分けるためにawaitする。await中に別の
      // Projectへ切り替えられても、musicLoadGenerationRefによる世代チェック（12章）により
      // 古い結果が新しいProjectのAudio Runtimeを上書きすることはない。
      const musicResult = await restoreMusicForProject(newProject);
      setProjectMenuOpen(false);

      if (musicResult && (musicResult.status === "missing" || musicResult.status === "error")) {
        setProjectBackupMessage({
          tone: "notice",
          text: "音源データはこのバックアップには含まれていません。必要に応じて音源を再設定してください。",
        });
      } else {
        setProjectBackupMessage({ tone: "notice", text: `「${newName}」を読み込みました。` });
      }
    },
    [isTransitionActive, workspace.projects, stopRuntimeForProjectSwitch, resetWork, work, restoreMusicForProject]
  );

  const canDeleteProject = workspace.projects.length > 1;
  const projectDeleteTarget = projectDeleteTargetId
    ? workspace.projects.find((p) => p.id === projectDeleteTargetId) || null
    : null;

  return (
    <div
      style={{ background: THEME.bg, color: THEME.text, fontFamily: "'Hiragino Sans', 'Yu Gothic', sans-serif" }}
      className="slsim-app w-full"
    >
      <style>{RESPONSIVE_STYLES}</style>
      {/* ヘッダー */}
      <header style={{ borderBottom: `1px solid ${THEME.border}`, background: THEME.bg }} className="slsim-header px-5 py-3 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div style={{ width: 10, height: 10, borderRadius: 999, background: THEME.accent }} />
          <h1 className="text-lg font-bold" style={{ letterSpacing: "0.02em" }}>舞台配置シミュレーター</h1>
          <span style={{ color: THEME.textDim }} className="text-xs hidden sm:inline">第1段階：ステージ設定 / 出演者配置</span>
          <ProjectSwitcher
            projects={workspace.projects}
            activeProjectId={workspace.activeProjectId}
            activeProjectName={activeProject.name}
            open={projectMenuOpen}
            disabled={isTransitionActive}
            renamingId={projectRenamingId}
            onToggleOpen={() => setProjectMenuOpen((v) => !v)}
            onClose={() => setProjectMenuOpen(false)}
            onSelectProject={switchProject}
            onCreateProject={createNewProject}
            onDuplicateProject={duplicateProject}
            onStartRename={(id) => setProjectRenamingId(id)}
            onCommitRename={(id, name) => {
              renameProject(id, name);
              setProjectRenamingId(null);
            }}
            onCancelRename={() => setProjectRenamingId(null)}
            onRequestDelete={(id) => {
              setProjectDeleteTargetId(id);
              setProjectMenuOpen(false);
            }}
            onExportProject={handleExportProjectBackup}
            onImportProject={triggerImportProjectBackup}
          />
          {/* Project Backup v1：ファイル選択自体は隠しinputに任せ、見た目上のボタンは
              ProjectSwitcherメニュー内の「プロジェクトを読み込む」だけにする。 */}
          <input
            ref={importFileInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: "none" }}
            onChange={handleImportFileSelected}
          />
          {/* 自動保存の実用化・PART E：既存UIを圧迫しない非常に小さな保存状態表示。
              新しい大きなボタンは追加せず、ヘッダーのタイトル付近に控えめなテキストとして
              置くだけに留める（常に強く目立たせない）。 */}
          <SaveStatusIndicator status={saveStatus} />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleHelp}
            aria-pressed={helpOpen}
            title="操作方法を表示／非表示"
            aria-label="操作方法を表示／非表示"
            style={{
              background: helpOpen ? THEME.accent : THEME.panelBg2,
              color: helpOpen ? "#141318" : THEME.text,
              border: `1px solid ${helpOpen ? THEME.accent : THEME.border}`,
            }}
            className="px-3 py-1.5 rounded-lg text-sm font-bold"
          >
            ？ 操作方法
          </button>
          <button
            onClick={toggleSidebar}
            aria-pressed={sidebarOpen}
            title={sidebarOpen ? "編集パネルを隠す" : "編集パネルを表示"}
            aria-label={sidebarOpen ? "編集パネルを隠す" : "編集パネルを表示"}
            style={{
              background: sidebarOpen ? THEME.panelBg2 : THEME.accent,
              color: sidebarOpen ? THEME.text : "#141318",
              border: `1px solid ${sidebarOpen ? THEME.border : THEME.accent}`,
            }}
            className="slsim-sidebar-toggle px-3 py-1.5 rounded-lg text-sm font-bold items-center gap-1.5"
          >
            {sidebarOpen ? "▶ 編集パネルを隠す" : "◀ 編集パネルを表示"}
          </button>
          <div style={{ width: 1, height: 20, background: THEME.border }} />
          <UndoRedoButton
            direction="undo"
            onClick={undoWork}
            disabled={!canUndo || isTransitionActive}
            title={isTransitionActive ? "再生中は元に戻せません" : `元に戻す（${UNDO_SHORTCUT_LABEL}）`}
          />
          <UndoRedoButton
            direction="redo"
            onClick={redoWork}
            disabled={!canRedo || isTransitionActive}
            title={isTransitionActive ? "再生中はやり直せません" : `やり直す（${REDO_SHORTCUT_LABEL}）`}
          />
          <div style={{ width: 1, height: 20, background: THEME.border }} />
          <ViewToggleButton active={viewMode === "top"} onClick={() => setViewMode("top")} label="平面図（真上）" />
          <ViewToggleButton active={viewMode === "front"} onClick={() => setViewMode("front")} label="俯瞰客席ビュー" />
        </div>
      </header>

      <div className={`slsim-workspace${sidebarOpen ? "" : " slsim-sidebar-collapsed"}`}>
        {/* ステージ表示エリア */}
        <main className="slsim-stage-pane">
          {/* 視点ごとの表示切替 */}
          <div className="flex items-center gap-4 mb-2 text-xs flex-wrap shrink-0" style={{ color: THEME.textDim }}>
            {viewMode === "top" && (
              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <input type="checkbox" checked={showBackstage} onChange={(e) => setShowBackstage(e.target.checked)} />
                待機エリア（下手袖・上手袖・舞台奥）を表示
              </label>
            )}
            {viewMode === "top" && (
              <label className="flex items-center gap-1.5 cursor-pointer select-none" title="出演者マーカーの丸の下に、設定済みの名前を小さく表示します（未設定の出演者には何も表示されません）">
                <input type="checkbox" checked={showPerformerNames} onChange={(e) => setShowPerformerNames(e.target.checked)} />
                出演者名を表示
              </label>
            )}
            {viewMode === "front" && (
              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showWaitingInOverhead}
                  onChange={(e) => setShowWaitingInOverhead(e.target.checked)}
                />
                待機中の出演者もこのビューに表示する
              </label>
            )}
            <label className="flex items-center gap-1.5 cursor-pointer select-none" title="現在の構成を基準にした移動軌跡を表示します">
              <input
                type="checkbox"
                checked={showTrajectory}
                onChange={(e) => setShowTrajectory(e.target.checked)}
              />
              移動軌跡を表示
            </label>
            {showTrajectory && (
              <div
                className="flex items-center gap-0.5"
                style={{ background: THEME.panelBg2, border: `1px solid ${THEME.border}`, borderRadius: 8, padding: 2 }}
                role="group"
                aria-label="移動軌跡の参照方向"
              >
                <button
                  type="button"
                  onClick={() => setTrajectoryMode("next")}
                  title="現在の構成→次の構成の軌跡を表示します（最後の構成では表示されません）"
                  style={{
                    background: trajectoryMode === "next" ? THEME.accent : "transparent",
                    color: trajectoryMode === "next" ? "#141318" : THEME.textDim,
                    border: "none",
                    borderRadius: 6,
                  }}
                  className="px-2 py-0.5 text-xs font-bold"
                >
                  次に
                </button>
                <button
                  type="button"
                  onClick={() => setTrajectoryMode("previous")}
                  title="前の構成→現在の構成の軌跡を表示します（最初の構成では表示されません）"
                  style={{
                    background: trajectoryMode === "previous" ? THEME.accent : "transparent",
                    color: trajectoryMode === "previous" ? "#141318" : THEME.textDim,
                    border: "none",
                    borderRadius: 6,
                  }}
                  className="px-2 py-0.5 text-xs font-bold"
                >
                  前に
                </button>
              </div>
            )}
            {/* 出演者表示サイズ v1.1・PART D・K：平面図の出演者マーカーサイズ専用の設定に
                役割を絞ったため、平面図（viewMode==="top"）でのみ表示する。俯瞰客席ビューでは
                このボタン群自体を出さないことで、「平面図でのみ効果がある」ことが自然に
                分かるようにする（身長の小中大ボタンとの混同を避けるためラベルも
                「平面図の出演者サイズ」とした）。 */}
            {viewMode === "top" && (
              <div className="flex items-center gap-1.5">
                <span>平面図の出演者サイズ</span>
                <div
                  className="flex items-center gap-0.5"
                  style={{ background: THEME.panelBg2, border: `1px solid ${THEME.border}`, borderRadius: 8, padding: 2 }}
                  role="group"
                  aria-label="平面図の出演者マーカー表示サイズ（大・中・小）"
                >
                  <button
                    type="button"
                    onClick={() => setPerformerDisplayScaleCommit(PERFORMER_DISPLAY_SCALE_SMALL)}
                    disabled={isTransitionActive}
                    title="平面図の出演者マーカー・番号・名前の表示サイズを小さくします（配置座標・身長は変わりません）"
                    style={{
                      background: performerDisplayScale === PERFORMER_DISPLAY_SCALE_SMALL ? THEME.accent : "transparent",
                      color: performerDisplayScale === PERFORMER_DISPLAY_SCALE_SMALL ? "#141318" : THEME.textDim,
                      border: "none",
                      borderRadius: 6,
                    }}
                    className="px-2 py-0.5 text-xs font-bold"
                  >
                    小
                  </button>
                  <button
                    type="button"
                    onClick={() => setPerformerDisplayScaleCommit(PERFORMER_DISPLAY_SCALE_MEDIUM)}
                    disabled={isTransitionActive}
                    title="平面図の出演者マーカー・番号・名前の表示サイズを中くらいにします"
                    style={{
                      background: performerDisplayScale === PERFORMER_DISPLAY_SCALE_MEDIUM ? THEME.accent : "transparent",
                      color: performerDisplayScale === PERFORMER_DISPLAY_SCALE_MEDIUM ? "#141318" : THEME.textDim,
                      border: "none",
                      borderRadius: 6,
                    }}
                    className="px-2 py-0.5 text-xs font-bold"
                  >
                    中
                  </button>
                  <button
                    type="button"
                    onClick={() => setPerformerDisplayScaleCommit(PERFORMER_DISPLAY_SCALE_LARGE)}
                    disabled={isTransitionActive}
                    title="平面図の出演者マーカー・番号・名前を標準の大きさで表示します"
                    style={{
                      background: performerDisplayScale === PERFORMER_DISPLAY_SCALE_LARGE ? THEME.accent : "transparent",
                      color: performerDisplayScale === PERFORMER_DISPLAY_SCALE_LARGE ? "#141318" : THEME.textDim,
                      border: "none",
                      borderRadius: 6,
                    }}
                    className="px-2 py-0.5 text-xs font-bold"
                  >
                    大
                  </button>
                </div>
              </div>
            )}
            {selectedIds.length >= 1 && (
              <div className="flex items-center gap-1.5">
                <span>移動経路</span>
                <div
                  className="flex items-center gap-0.5"
                  style={{ background: THEME.panelBg2, border: `1px solid ${THEME.border}`, borderRadius: 8, padding: 2 }}
                  role="group"
                  aria-label="選択中の出演者の移動経路（直線／曲線）"
                >
                  <button
                    type="button"
                    onClick={() => setSelectedPathMode("linear")}
                    disabled={editablePerformerIds.length === 0 || isTransitionActive}
                    title="選択中の出演者を直線移動に戻します"
                    style={{
                      background: selectedPathTypeSummary === "linear" || selectedPathTypeSummary === null ? THEME.accent : "transparent",
                      color: selectedPathTypeSummary === "linear" || selectedPathTypeSummary === null ? "#141318" : THEME.textDim,
                      border: "none",
                      borderRadius: 6,
                      opacity: editablePerformerIds.length > 0 ? 1 : 0.4,
                      cursor: editablePerformerIds.length > 0 && !isTransitionActive ? "pointer" : "default",
                    }}
                    className="px-2 py-0.5 text-xs font-bold"
                  >
                    直線
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedPathMode("curve")}
                    disabled={editablePerformerIds.length === 0 || isTransitionActive}
                    title={
                      editablePerformerIds.length > 0
                        ? "選択中の出演者を、1つの通過点を使った曲線移動にします（複数選択時は各自独立した通過点を生成し、既にcurve設定済みの出演者はそのまま維持します）"
                        : "選択中の出演者には現在表示中の方向（次に／前に）で移動先の構成がありません"
                    }
                    style={{
                      background: selectedPathTypeSummary === "curve" ? THEME.accent : "transparent",
                      color: selectedPathTypeSummary === "curve" ? "#141318" : THEME.textDim,
                      border: "none",
                      borderRadius: 6,
                      opacity: editablePerformerIds.length > 0 ? 1 : 0.4,
                      cursor: editablePerformerIds.length > 0 && !isTransitionActive ? "pointer" : "default",
                    }}
                    className="px-2 py-0.5 text-xs font-bold"
                  >
                    曲線
                  </button>
                </div>
                {selectedPathTypeSummary === "mixed" && (
                  <span style={{ color: THEME.textDim }} className="text-xs">
                    複数の設定
                  </span>
                )}
                {/* 待機エリア間スマート経路v1：まだ手動で確定されていない自動提案の曲線を
                    表示している場合だけ、小さなbadgeで「自動経路」であることを示す（14章）。
                    強制経路ではなく初期提案であることが伝わればよいため、大きな操作パネルは追加しない。 */}
                {selectedPathTypeSummary === "curve" && isSelectionPureAutoPath && (
                  <span
                    title="待機エリア間の移動のため、ステージ外側を通る経路を自動提案しています（通過点をドラッグすると手動設定に切り替わります）"
                    style={{
                      color: THEME.accent,
                      border: `1px solid ${THEME.accent}`,
                      borderRadius: 999,
                      padding: "1px 6px",
                    }}
                    className="text-xs font-bold"
                  >
                    自動経路
                  </span>
                )}
              </div>
            )}
            {isMultiSelect && (
              <span style={{ color: THEME.accent }} className="font-bold">
                {selectedIds.length}人選択中
              </span>
            )}
          </div>

          {/* ズーム・表示ツールバー */}
          <ZoomToolbar
            zoom={activeViewState.zoom}
            onZoomIn={() => zoomBy(ZOOM_STEP)}
            onZoomOut={() => zoomBy(-ZOOM_STEP)}
            onReset100={resetZoomTo100}
            onFitAll={() => activeViewRef.current && activeViewRef.current.fitAll()}
            onFitStage={() => activeViewRef.current && activeViewRef.current.fitStage()}
            onFitSelected={() => activeViewRef.current && activeViewRef.current.fitSelected()}
            selectedDisabled={selectedIds.length === 0}
          />

          <div
            ref={containerRef}
            onWheel={handleWheelZoom}
            style={{
              background: THEME.panelBg,
              border: `1px solid ${THEME.border}`,
              borderRadius: 14,
              flex: 1,
              minHeight: 0,
              position: "relative",
              overflow: "hidden",
              // 出演者配置キャンバス（平面図・俯瞰客席ビュー）全体でテキスト選択を無効化する（9章）。
              // 右側編集パネル（<aside>、inputなど）はこの要素の外側のため影響しない。
              userSelect: "none",
              WebkitUserSelect: "none",
            }}
            className="flex items-center justify-center"
          >
            {viewMode === "top" ? (
              <TopView
                ref={activeViewRef}
                stage={stage}
                zones={zones}
                performers={performers}
                placements={displayPlacementsWithScrub}
                selectedIds={selectedIds}
                onSelect={selectOnly}
                onToggleSelect={toggleSelect}
                onDragGroup={dragGroup}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onRectSelect={handleRectSelect}
                overlapIds={overlapIds}
                showBackstage={showBackstage}
                showPerformerNames={showPerformerNames}
                performerDisplayScale={performerDisplayScale}
                performerNameScale={performerNameScale}
                viewState={activeViewState}
                onViewStateChange={handleViewStateChange}
                width={containerSize.width}
                height={containerSize.height}
                locked={isTransitionActive}
                transitionPaths={transitionPaths}
                waypointHandle={waypointHandle}
                onWaypointDrag={updateWaypointLive}
              />
            ) : (
              <OverheadAudienceView
                ref={activeViewRef}
                stage={stage}
                zones={zones}
                performers={performers}
                placements={displayPlacementsWithScrub}
                selectedIds={selectedIds}
                onSelect={selectOnly}
                onToggleSelect={toggleSelect}
                overlapIds={overlapIds}
                showWaiting={showWaitingInOverhead}
                viewState={activeViewState}
                onViewStateChange={handleViewStateChange}
                width={containerSize.width}
                height={containerSize.height}
                locked={isTransitionActive}
                transitionPaths={transitionPaths}
              />
            )}

            {/* 現在選択中の構成名のステータス表示。「01 / 03　構成名」の1行のみで、
                補足ラベルは付けない。ステージのクリック／ドラッグ／パン操作を妨げないよう
                pointerEvents:noneにし、ステージ下部の余白に重ねて表示する
                （カードやボタンのような背景は付けず、シンプルなテキストのみ）。 */}
            <div
              style={{
                position: "absolute",
                left: "50%",
                bottom: 10,
                transform: "translateX(-50%)",
                width: "min(420px, calc(100% - 24px))",
                display: "flex",
                alignItems: "baseline",
                justifyContent: "center",
                gap: 6,
                pointerEvents: "none",
              }}
              title={`${slideOrderLabel} / ${slideTotalLabel}　${currentSlide.name}`}
            >
              <span style={{ color: THEME.textDim, fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
                {slideOrderLabel} / {slideTotalLabel}
              </span>
              <span
                style={{
                  color: THEME.text,
                  fontSize: 13,
                  fontWeight: 700,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {currentSlide.name}
              </span>
            </div>
          </div>

          {/* 構成バー（複数スライド機能の土台）。ステージの表示領域をなるべく維持するため
              高さは最小限（80〜100px程度）に抑える。構成の切替はUndo対象外。 */}
          <CompositionBar
            slides={slides}
            currentIndex={currentSlideIndex}
            onSelect={goToSlide}
            onPrev={goToPrevSlide}
            onNext={goToNextSlide}
            onAddNew={addNewSlide}
            onDeleteSlide={() => setSlideDeleteTargetIndex(currentSlideIndex)}
            canDeleteSlide={slides.length > 1}
            onReorder={moveSlide}
            onShowList={() => setSlideListOpen(true)}
            playbackState={animationState.playbackState}
            dataEditLocked={isTransitionActive}
            canPlay={canPlayTransitionFinal}
            onPlay={handlePlaySingleClick}
            onPause={handleCompositionPauseClick}
            onReturnToEdit={handleCompositionReturnToEditClick}
            canPlayContinuous={canPlayContinuousFinal}
            onPlayContinuous={handlePlayContinuousClick}
            statusLabel={playbackStatusLabel}
            hasNextSlideForTransition={hasNextSlideForTransition}
            transitionCounts={currentTransitionCounts}
            onStepTransitionCounts={stepTransitionCounts}
            onCommitTransitionCounts={setTransitionCountsCommit}
            canStartSyncPlayback={canStartSyncPlayback}
            syncPlaybackBlockedReason={syncPlaybackBlockedReason}
            syncPlaybackActive={syncPlayback.isActive}
            syncPlaybackPaused={syncPlayback.isPaused}
            onStartSyncPlayback={startSyncPlayback}
            onResumeSyncPlayback={resumeSyncPlayback}
            syncDriftSec={syncDriftSecForDisplay}
            syncPlaybackPreroll={syncPlaybackIsPreroll}
            syncPrerollRemainingSec={syncPrerollRemainingSec}
            musicPlaybackPositionLabel={musicPlaybackPositionLabel}
            syncAnimationStatusLabel={syncAnimationStatusLabel}
            onExportPng={openExportCenter}
            pngExportDisabled={pngExportDisabled}
          />

          {/* Export Center v1・23章：待機エリア表示チェックボックス・PNGビュー表示・
              エラーバナーは、常設の編集画面バナーからExport Centerモーダル内部へ移した。
              Export Centerを閉じれば、この付近の見た目は従来とほぼ同じ（構成バーのすぐ下に
              スクラバーが続く）に戻る。 */}

          {/* 構成間アニメーション・スクラバー（正式機能）。
              CompositionBarのprops構造には手を加えず、独立したJSXブロックとして実装してある。
              現在の構成→次の構成の途中状態を、0〜transitionCounts の範囲でスライダー確認できる。
              idle・paused中は操作可能で、一時停止中に動かすと表示中の配置がその場でライブ更新される。
              実際にrAFが進行中（playing）の間だけ操作不可にし、実際の再生進捗
              （animationState.progress）をそのまま表示する。
              重要：このコンテナ自体は「次の構成があるかどうか」に関わらず常にマウントしたままにする
              （hasNextSlideForScrubで丸ごと出し分けると、最後の構成だけこの行の高さが無くなり、
              下のステージ表示領域（flex:1）がその分だけ広がって構成切替のたびにステージのサイズが
              上下してしまうため）。最後の構成では中身をvisibility:hiddenにして見た目だけ隠す
              （display:noneではなくvisibility:hiddenにすることで、レイアウト上の高さはそのまま残る）。
              scrubProgressやアニメーションのロジック自体はここでは一切変更していない。 */}
          <div className="flex items-center gap-2 mt-2 text-xs shrink-0" style={{ color: THEME.textDim }}>
            <span style={{ flexShrink: 0, visibility: hasNextSlideForScrub ? "visible" : "hidden" }}>スクラバー</span>
            <input
              type="range"
              min={0}
              max={1}
              step={hasNextSlideForScrub && scrubTransitionCounts > 0 ? 0.5 / scrubTransitionCounts : 0.01}
              value={hasNextSlideForScrub ? scrubDisplayProgress : 0}
              disabled={!canScrubFinal}
              onChange={(e) => setScrubProgress(Number(e.target.value))}
              title={
                syncPlaybackPausedActive
                  ? "音楽シークで構成位置を確認中です（音楽シークバーを操作してください）"
                  : hasNextSlideForScrub
                  ? "現在の構成→次の構成の途中状態を手動で確認します（作品データは変更されません）"
                  : "次の構成が無いため、スクラバーは使用できません"
              }
              style={{
                flex: 1,
                maxWidth: 220,
                accentColor: THEME.accent,
                opacity: canScrubFinal ? 1 : 0.5,
                visibility: hasNextSlideForScrub ? "visible" : "hidden",
              }}
            />
            {/* 現在カウント部分（0.5刻みで桁数が変わる）だけFixedCountValueで固定幅にし、
                横幅の変化でスクラバー横のUIがずれないようにする（キープ進捗表示と共通のコンポーネント）。
                スクラバー自体の幅・位置・機能は変更していない。 */}
            <span
              style={{
                flexShrink: 0,
                visibility: hasNextSlideForScrub ? "visible" : "hidden",
              }}
            >
              <FixedCountValue value={hasNextSlideForScrub ? roundToHalfCount(scrubDisplayProgress, scrubTransitionCounts) : 0} />
              {" / "}
              {hasNextSlideForScrub ? scrubTransitionCounts : 0} count
            </span>
          </div>

          {/* Music Bar（Music基盤 v2：Web Audio API方式）：構成間アニメーションとは完全に独立した、
              音楽ファイルの読み込み・再生・一時停止・シーク専用のコンパクトな1行バー。構成バー・
              スクラバーのすぐ下、警告バーの上に配置し、ステージ表示area（flex:1）を圧迫しないよう
              最小限の高さに留める。31章：ここでの▶/⏸は構成アニメーションの再生を一切トリガーしない
              （逆も同様）。実体の再生制御（AudioContext/AudioBuffer/AudioBufferSourceNode）は
              すべてApp側のruntime refで管理し、このコンポーネントには状態と操作ハンドラだけを渡す。 */}
          <MusicBar
            musicMeta={musicMeta}
            musicStatus={musicStatus}
            musicCurrentTime={musicCurrentTime}
            musicError={musicError}
            musicDiagnostics={musicDiagnostics}
            projectBpm={projectBpm}
            musicTotalEighths={musicTotalEighths}
            onFileChange={handleMusicFileChange}
            onPlayPause={handleMusicPlayPause}
            onSeek={handleMusicSeek}
            onSeekCommit={handleMusicSeekCommit}
            onRemove={handleRemoveMusicAsset}
            syncActive={syncPlayback.isActive}
            syncPaused={syncPlayback.isPaused}
            syncSeekPreview={syncSeekPreview}
            formationMarkers={formationMarkers}
            sectionBoundaryMarkers={sectionBoundaryMarkers}
            currentSlideIndex={currentSlideIndex}
            onMarkerClick={handleFormationMarkerClick}
            markersInteractive={!isTransitionActive}
          />

          {/* 警告バー */}
          {(overlapIds.size > 0 || outOfRangeCount > 0) && (
            <div className="mt-3 flex flex-wrap items-center gap-3 text-sm shrink-0" style={{ color: THEME.danger }}>
              {overlapIds.size > 0 && <span>⚠ 位置が重なっている出演者がいます</span>}
              {outOfRangeCount > 0 && (
                <span className="flex items-center gap-2">
                  ⚠ ステージ・袖・待機エリアの外側に出ている出演者が {outOfRangeCount} 人います
                  <button
                    onClick={returnAllToStage}
                    disabled={isTransitionActive}
                    style={{ background: THEME.accent, color: "#141318", opacity: isTransitionActive ? 0.5 : 1 }}
                    className="px-2 py-0.5 rounded font-bold text-xs"
                  >
                    すべてステージ内に戻す
                  </button>
                </span>
              )}
            </div>
          )}
        </main>

        {/* 設定パネル */}
        <aside className="slsim-sidebar">
          {/* 操作方法（折りたたみ）：ヘッダーの「？ 操作方法」で開閉。ステージのサイズには影響しない */}
          {helpOpen && (
            <section className="slsim-help-panel">
              <h3>配置操作</h3>
              <ul>
                <li>「出演者の追加」で人を配置します。</li>
                <li>平面図では出演者をドラッグして移動できます（0.5マス単位で吸着）。</li>
                <li>ステージ本体だけでなく、下手袖・上手袖・舞台奥の待機エリアにもドラッグして移動できます。</li>
                <li>出演者をクリックすると選択され、サイドバーで番号・色・身長・座標を編集できます。</li>
              </ul>
              <h3>複数選択</h3>
              <ul>
                <li>Shift＋クリックで選択の追加・解除ができます。</li>
                <li>平面図でShift＋空白ドラッグすると矩形範囲選択ができます。</li>
                <li>選択中の1人をドラッグすると、選択中全員が相対位置を保ったまま一緒に動きます。</li>
              </ul>
              <h3>拡大縮小・画面移動</h3>
              <ul>
                <li>右上のツールバーの「＋」「−」で拡大縮小、空白部分のドラッグで画面移動できます。</li>
                <li>キーボードの「+」「−」「0」（Command／Ctrlとの併用も可）でも拡大縮小できます。</li>
                <li>スマートフォンは指でのドラッグ、トラックパッドは通常のドラッグ（2本指ではない）で移動してください。</li>
              </ul>
              <h3>元に戻す／やり直す</h3>
              <ul>
                <li>ヘッダーのボタン、またはCommand／Ctrl+Zで元に戻せます。</li>
                <li>Command／Ctrl+Shift+Z、またはCtrl+Yでやり直せます。</li>
              </ul>
            </section>
          )}

          {/* 右編集パネルの整理 v1（PART D）：「全体の設定」＝プロジェクト全体に関わる設定
              （ステージ・project BPM・楽曲セクション）をひとまとめにする（16章）。 */}
          <CollapsibleGroup
            title="全体の設定"
            icon="🌐"
            open={globalSettingsOpen}
            onToggle={() => setGlobalSettingsOpen((v) => !v)}
          >
          {/* 1. ステージ設定 */}
          <section>
            <SectionTitle>ステージ設定</SectionTitle>
            <div className="flex flex-col gap-2 mt-2">
              <NumberField
                label={`幅（横方向） / ${WIDTH_MIN}〜${WIDTH_MAX}`}
                value={stage.width}
                min={WIDTH_MIN}
                max={WIDTH_MAX}
                step={1}
                onButtonChange={setStageWidthCommit}
                onInputChange={setStageWidthLive}
                onInputFocus={beginEdit}
                onInputBlur={endEdit}
                onInputKeyDown={commitOnEnter}
                suffix={`= ${stage.width * UNIT_CM}cm`}
              />
              <NumberField
                label={`奥行 / ${DEPTH_MIN}〜${DEPTH_MAX}`}
                value={stage.depth}
                min={DEPTH_MIN}
                max={DEPTH_MAX}
                step={1}
                onButtonChange={setStageDepthCommit}
                onInputChange={setStageDepthLive}
                onInputFocus={beginEdit}
                onInputBlur={endEdit}
                onInputKeyDown={commitOnEnter}
                suffix={`= ${stage.depth * UNIT_CM}cm`}
              />
              <p style={{ color: THEME.textDim }} className="text-xs mt-1">
                1マス = 90cm四方。横は中央が0、下手が−、上手が＋。奥行は舞台前端が0です。
              </p>
            </div>
          </section>

          <Divider />

          {/* BPM：slideごとの値ではなく、プロジェクト全体で共通の値（work.project.bpm）。
              「このプロジェクト／使用曲の時間軸を決める値」として扱うため、ステージ設定の
              すぐ下にまとめて配置する。countsToDurationMsの計算に使われるため、
              変更するとtransitionCounts・keepCountsの実時間（秒）だけが変わり、
              カウント数自体やslides/placements/transitionPathsは一切変更しない。
              再生中・一時停止中は誤操作防止のため編集不可にする（25章：安全性を優先）。 */}
          <section>
            <SectionTitle>BPM</SectionTitle>
            <div className="mt-2">
              {/* 入力操作の改善 v2（PART B）：project BPMもDraftNumberFieldへ統一し、
                  ＋／−ボタンに加えてキーボードから直接入力できるようにする（10〜11章）。
                  小数BPM（127.5等）にも対応するためallowDecimalを指定する（15章）。 */}
              <DraftNumberField
                label={`テンポ（1分間の拍数） / ${MIN_BPM}〜${MAX_BPM}`}
                value={projectBpm}
                min={MIN_BPM}
                max={MAX_BPM}
                step={1}
                allowDecimal
                onButtonChange={setBpmCommit}
                onCommit={setBpmCommit}
                disabled={isTransitionActive}
                suffix={`4カウント = ${(countsToDurationMs(4, projectBpm) / 1000).toFixed(2)}秒`}
              />
              {/* PART E：常時有用な数値情報（4カウント=○秒、上のsuffix）は残しつつ、概念的な
                  説明文は「説明を見る」の中へ移動する（23〜24章）。再生中の警告は判断に必要な
                  情報のため常時表示のままにする。 */}
              <div className="flex items-center justify-between mt-1">
                <InfoToggle open={!!descOpen.bpm} onToggle={() => toggleDesc("bpm")} />
                {isTransitionActive && (
                  <span style={{ color: THEME.danger }} className="text-[11px]">再生中・一時停止中は変更できません</span>
                )}
              </div>
              {descOpen.bpm && (
                <p style={{ color: THEME.textDim }} className="text-[11px] leading-relaxed mt-1">
                  このプロジェクト全体で共通のBPMです（構成ごとの値ではありません）。キープ・移動のカウント数はそのままに、実際に再生したときの秒数だけが変わります。
                </p>
              )}
            </div>
          </section>

          <Divider />

          {/* 楽曲セクション（Music Section基盤・PART C・新規）。
              音源全体の絶対時間軸（0秒〜music duration）はそのまま維持し、その上に載る
              「1曲目／2曲目／SE」などの区切りメタデータをwork.project.musicSectionsとして
              持たせる編集UI。現在はMusic Anchor経由で構成（slide）と紐づき、各Sectionの
              startSec・countStartSec・bpmは実際の音楽同期再生・keep/move phaseの実時間計算に
              使われている（35章・38章）。
              追加・削除・各フィールドの編集はUndo/Redo対象（39章）。 */}
          <section>
            <SectionTitle>楽曲セクション</SectionTitle>
            <div className="mt-1">
              <InfoToggle open={!!descOpen.musicSection} onToggle={() => toggleDesc("musicSection")} />
            </div>
            {descOpen.musicSection && (
              <p style={{ color: THEME.textDim }} className="text-[11px] leading-relaxed mt-1">
                音源の中の「1曲目」「2曲目」などの区切りです。「開始」はそのSectionの音そのものが始まる位置、「カウント開始」は1エイト目・1カウント目が始まる位置です（イントロ等、間に前奏がある場合は分けて設定できます）。通常の同期再生（♫▶）は、構成が指す音楽位置（Anchor）の時刻から音楽と構成アニメーションを同時に開始します。「開始」から自動的にイントロが流れることはありません。曲頭から確認したい場合は、手動Music Anchorを設定した構成の「音楽位置」で再生開始を「曲頭から」に切り替えると、「開始」から音楽が鳴り、Anchorに到達すると構成アニメーションが始まります。時刻は「94.5」のような秒数、「1:34.5」のような分:秒のどちらでも入力できます。BPMは自動解析ではありません。楽曲のBPMを確認して入力してください。
              </p>
            )}
            <div className="flex flex-col gap-2 mt-2">
              {musicSections.map((section, index) => {
                const canRemove = musicSections.length > 1;
                return (
                  <div
                    key={section.id}
                    style={{ background: THEME.panelBg2, border: `1px solid ${THEME.border}` }}
                    className="rounded-lg p-2"
                  >
                    <div className="flex items-center gap-1 mb-1.5">
                      <span style={{ color: THEME.textDim }} className="text-[10px] shrink-0">#{index + 1}</span>
                      <input
                        type="text"
                        value={section.name}
                        onFocus={beginEdit}
                        onChange={(e) => updateMusicSectionLive(section.id, { name: e.target.value })}
                        onBlur={endEdit}
                        onKeyDown={commitOnEnter}
                        placeholder="セクション名（例：1曲目）"
                        style={inputStyle}
                        className="flex-1 min-w-0 rounded px-2 py-1 text-xs font-bold"
                      />
                      <button
                        type="button"
                        onClick={() => removeMusicSectionCommit(section.id)}
                        disabled={!canRemove}
                        title={canRemove ? "このセクションを削除" : "最後の1セクションは削除できません"}
                        style={
                          canRemove
                            ? { background: THEME.panelBg, border: `1px solid ${THEME.danger}`, color: THEME.danger }
                            : { background: THEME.panelBg, border: `1px solid ${THEME.borderSoft}`, color: THEME.textDim }
                        }
                        className="w-6 h-6 rounded shrink-0 text-xs font-bold"
                      >
                        ×
                      </button>
                    </div>
                    {/* Music Timing v1.5・2〜6章：開始・カウント開始は「分:秒」表示・入力に対応した
                        TimeInputFieldへ置き換える（内部データはこれまで通りstartSec/countStartSecの
                        秒数Numberのまま＝データ構造は変更しない）。BPMは時刻ではないため、従来通り
                        draft文字列対応のDraftNumberFieldのまま維持する。入力操作の改善v1と同じく、
                        blur/Enterで確定するまではローカルのdraft文字列のまま保持し、確定は
                        1回のcommit＝1件のUndo履歴（5章）。 */}
                    <div className="grid grid-cols-3 gap-1">
                      <TimeInputField
                        label="開始"
                        value={section.startSec}
                        onCommit={(next) => updateMusicSectionCommit(section.id, { startSec: next })}
                        disabled={isTransitionActive}
                      />
                      <TimeInputField
                        label="カウント開始"
                        value={section.countStartSec}
                        onCommit={(next) => updateMusicSectionCommit(section.id, { countStartSec: next })}
                        disabled={isTransitionActive}
                      />
                      {/* Music Sync Playback v1・35章：同期再生中はSection BPM/countStartSec/startSecを
                          変更できないようにする（同期再生開始時のAnchor計算条件を途中で変えないため）。
                          既存のisTransitionActiveをそのまま再利用（再生中・一時停止中の両方でtrue。
                          Music Timing v1.5からはプリロール中もこのisTransitionActiveがtrueになる）。 */}
                      <label className="flex flex-col gap-0.5 min-w-0">
                        <span style={{ color: THEME.textDim, fontSize: 9 }}>BPM</span>
                        <DraftNumberField
                          value={section.bpm}
                          min={MIN_BPM}
                          max={MAX_BPM}
                          step={1}
                          allowDecimal
                          onCommit={(next) => updateMusicSectionCommit(section.id, { bpm: clampBpm(next) })}
                          inputClassName="w-full rounded px-1 py-1 text-xs text-center"
                          disabled={isTransitionActive}
                        />
                      </label>
                    </div>
                    {/* Music Timing v1.5・13章：countStartSec < startSecは不正なSection設定。
                        自動補正せず、warningのみ表示する（作品データは書き換えない）。 */}
                    {Number.isFinite(section.countStartSec) && Number.isFinite(section.startSec) && section.countStartSec < section.startSec && (
                      <p style={{ color: THEME.danger }} className="text-[10px] leading-relaxed mt-1">
                        ⚠ カウント開始は楽曲開始より前に設定されています。
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            <button
              type="button"
              onClick={addMusicSectionCommit}
              style={{ background: THEME.panelBg2, border: `1px solid ${THEME.accent}`, color: THEME.accent }}
              className="w-full mt-2 rounded-lg py-1.5 text-xs font-bold"
            >
              ＋ セクション追加
            </button>
          </section>
          </CollapsibleGroup>

          {/* 「構成ごとの設定」＝現在選択中の構成（currentSlide）・出演者編集に関わる設定
              をひとまとめにする（17章）。 */}
          <CollapsibleGroup
            title="構成ごとの設定"
            icon="🎬"
            open={slideSettingsOpen}
            onToggle={() => setSlideSettingsOpen((v) => !v)}
          >
          {/* 構成名（現在選択中の構成の名前。構成カードには番号のみ表示するため、
              名前の確認・編集はここで行う。構成の複数選択は実装していないため常に単一の
              構成＝現在の構成が対象になる）。 */}
          <section>
            <SectionTitle>構成名</SectionTitle>
            <div className="mt-2">
              <input
                type="text"
                value={currentSlide.name}
                onFocus={beginEdit}
                onChange={(e) => setCurrentSlideNameLive(e.target.value)}
                onBlur={handleSlideNameBlur}
                onKeyDown={handleSlideNameKeyDown}
                onCompositionStart={handleSlideNameCompositionStart}
                onCompositionEnd={handleSlideNameCompositionEnd}
                placeholder="構成名"
                style={inputStyle}
                className="w-full rounded px-2 py-1.5 text-sm font-bold"
              />
              <p style={{ color: THEME.textDim }} className="text-[11px] leading-relaxed mt-1">
                空欄のまま確定すると「構成○」という自動の名前に戻ります。
              </p>
            </div>
          </section>

          {/* キープ：「この構成のまま何カウント維持するか」＝構成そのものの属性。
              構成と構成の「間」の属性である移動時間（transitionCounts、構成バー側にあるもの）とは
              明確に別物として、構成名のすぐ近くにまとめて配置する。
              エイト換算は移動時間と全く同じ formatEighthsLabel() をそのまま再利用する
              （換算ロジックの二重実装はしない）。今回はまだ連続再生には使わない
              （保存・編集ができるだけでよい）。 */}
          <section>
            <SectionTitle>キープ</SectionTitle>
            <div className="mt-2">
              <KeepCountsField
                value={currentKeepCounts}
                min={MIN_KEEP_COUNTS}
                max={9999}
                step={1}
                allowDecimal={false}
                onButtonChange={setKeepCountsCommit}
                onCommit={setKeepCountsCommit}
                eighthsLabel={formatEighthsLabel(currentKeepCounts)}
                disabled={isTransitionActive}
              />
              {/* PART E：エイト換算（eighthsLabel）は判断に使う数値情報なので常時表示のまま残し、
                  「キープとは何か」という概念説明だけを「説明を見る」へ移動する（23〜24章）。 */}
              <div className="mt-1">
                <InfoToggle open={!!descOpen.keepCounts} onToggle={() => toggleDesc("keepCounts")} />
              </div>
              {descOpen.keepCounts && (
                <p style={{ color: THEME.textDim }} className="text-[11px] leading-relaxed mt-1">
                  0にすると、この構成に留まらずすぐ次の移動へ入ります。
                </p>
              )}
              {/* 前後のカウント補助表示 v1（表示整理）：現在構成を開いたまま「前から何カウントで
                  入ってきて、次へ何カウントで移動するか」を確認できる、控えめな補助表示。
                  「キープ」項目はすぐ上の既存キープカウント編集UIで確認できるため、この補助表示
                  からは削除し、前後の移動カウント2項目だけに役割を絞った（表示文言・レイアウトの
                  変更のみ。previousTransitionCounts/nextTransitionCountsForCurrentの取得ロジック
                  自体は無変更）。編集UIは持たない（表示のみ＝前からの移動時間は前のslideが
                  所有するtransitionCountsのため、ここから直接編集できるようにはしない）。
                  合計カウント・エイト換算は表示しない（どの範囲を1つのまとまりとして考えるかは
                  ユーザーによって異なるため、アプリ側で合計尺を決めつけない）。
                  前後の構成そのものが存在しない場合は「—」、実際に0countが設定されている
                  場合は「0 count」と表示し、両者を混同しない（null判定はそのまま維持）。 */}
              <div className="mt-2 flex items-center gap-2 text-[11px]" style={{ color: THEME.textDim }}>
                <span>
                  前・移動 <span style={{ color: THEME.text, fontWeight: 700 }}>{previousTransitionCounts == null ? "—" : `${previousTransitionCounts} count`}</span>
                </span>
                <span style={{ color: THEME.borderSoft }}>｜</span>
                <span>
                  次・移動 <span style={{ color: THEME.text, fontWeight: 700 }}>{nextTransitionCountsForCurrent == null ? "—" : `${nextTransitionCountsForCurrent} count`}</span>
                </span>
              </div>
            </div>
          </section>

          <Divider />

          {/* 音楽位置（Music Anchor v1 → Auto Chain v1）：「この構成が音楽上のどの位置に対応するか」。
              構成名・キープと同じく、slide自身の属性（35章：コンパクトに。説明文は最小限）。
              Auto Chain v1からは、手動Anchor（currentMusicAnchor）が無い構成でも、前方の手動Anchor
              からkeepCounts/transitionCountsで自動計算した位置（effectiveMusicAnchor）を表示する
              （14章）。手動/自動の分岐は「未設定」枝と「値がある」枝の2つのままにし（13〜14章：
              自動計算できる場合は「未設定」ではなく自動位置を出す）、値がある枝の中でバッジ・
              ボタン文言だけをisMusicAnchorManualで出し分ける。 */}
          <section>
            <SectionTitle>音楽位置</SectionTitle>
            {/* PART C・E：「1エイト目・1カウント目」の意味は常時長文で説明せず、
                「説明を見る」の中へ入れる（15章・25章）。Auto Chain v1・37章：自動連鎖の
                説明も同じ場所へ簡潔に追記する（常時長文表示はしない）。 */}
            <div className="mt-1">
              <InfoToggle open={!!descOpen.musicAnchor} onToggle={() => toggleDesc("musicAnchor")} />
            </div>
            {descOpen.musicAnchor && (
              <p style={{ color: THEME.textDim }} className="text-[11px] leading-relaxed mt-1">
                「1エイト目・1カウント目」＝そのMusic Sectionのカウント開始位置（countStartSec）そのものです。曲の開始秒（startSec）とカウント開始秒（countStartSec）は別物で、その間はイントロ等カウント前の区間として扱えます。0エイト目は作りません。通常の同期再生（♫▶）は、この構成が指す音楽位置の時刻から音楽と構成アニメーションを同時に開始するため、startSec〜countStartSecの区間が自動的に再生されることはありません。
                音楽位置は、前の「手動」位置を起点に、キープ・移動時間から自動計算されます（[自動]）。キープ／移動時間を変更すると、その後ろの自動位置も一緒に調整されます。Section／エイト／カウントを編集するか「手動に固定」を押すと、その構成から新しい手動位置（[手動]）になり、それより前の変更の影響を受けなくなります。
              </p>
            )}
            <div className="mt-2">
              {!effectiveMusicAnchor ? (
                <div className="flex items-center justify-between gap-2">
                  <span style={{ color: THEME.textDim }} className="text-xs">未設定</span>
                  <button
                    type="button"
                    onClick={enableMusicAnchorCommit}
                    disabled={isTransitionActive}
                    title={isTransitionActive ? "再生中・一時停止中は変更できません" : undefined}
                    style={{ background: THEME.panelBg2, border: `1px solid ${THEME.accent}`, color: THEME.accent, opacity: isTransitionActive ? 0.5 : 1 }}
                    className="px-2 py-1.5 rounded-lg text-xs font-bold"
                  >
                    音楽位置を設定
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {/* 36章：自動／手動を小さなbadgeで区別する（派手すぎない色）。 */}
                  <span
                    style={{
                      alignSelf: "flex-start",
                      color: isMusicAnchorManual ? THEME.accent : THEME.textDim,
                      border: `1px solid ${isMusicAnchorManual ? THEME.accent : THEME.borderSoft}`,
                      borderRadius: 999,
                    }}
                    className="px-1.5 py-0.5 text-[10px] font-bold"
                  >
                    {isMusicAnchorManual ? "手動" : "自動"}
                  </span>
                  {/* Music Sync Playback v1・34〜35章：同期再生開始時のAnchor計算条件を再生中に
                      変えられないよう、既存のisTransitionActive（再生中・一時停止中の両方でtrue）で
                      音楽位置の編集UI全体をロックする。BPM・キープと全く同じ既存の考え方の再利用。
                      Auto Chain v1・15章：自動表示中にこれらを編集すると、
                      updateCurrentSlideMusicAnchorCommit側の仕組みにより自動的に手動Anchorへ昇格する。 */}
                  <select
                    value={effectiveMusicAnchor.sectionId}
                    onChange={(e) => setMusicAnchorSectionCommit(e.target.value)}
                    disabled={isTransitionActive}
                    style={isTransitionActive ? { background: THEME.panelBg, border: `1px solid ${THEME.borderSoft}`, color: THEME.textDim } : inputStyle}
                    className="w-full rounded px-2 py-1.5 text-xs font-bold"
                  >
                    {musicSections.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                  {/* 入力操作の改善 v1（PART B）：以前は type="number" のcontrolled inputへ
                      onChangeのたびに即Number化した値をそのまま反映していたため、初期値「1」の
                      状態で「2」と打鍵すると末尾に連結されて「12」になってしまっていた（6章）。
                      DraftNumberFieldはfocus時にテキストを全選択し、blur/Enterまではdraft文字列
                      のまま保持するため、この問題が起きない（7〜9章）。＋／－ボタンは維持（10章）。 */}
                  <div className="grid grid-cols-2 gap-1.5">
                    <DraftNumberField
                      label="エイト"
                      value={effectiveMusicAnchor.eighthNumber}
                      min={MIN_MUSIC_ANCHOR_EIGHTH}
                      max={MAX_MUSIC_ANCHOR_EIGHTH}
                      step={1}
                      onButtonChange={setMusicAnchorEighthCommit}
                      onCommit={setMusicAnchorEighthCommit}
                      disabled={isTransitionActive}
                    />
                    <DraftNumberField
                      label="カウント"
                      value={musicAnchorCountOffsetToDisplayCount(effectiveMusicAnchor.countOffset)}
                      min={musicAnchorCountOffsetToDisplayCount(MIN_MUSIC_ANCHOR_COUNT_OFFSET)}
                      max={musicAnchorCountOffsetToDisplayCount(MAX_MUSIC_ANCHOR_COUNT_OFFSET)}
                      step={1}
                      onButtonChange={setMusicAnchorCountOffsetCommit}
                      onCommit={setMusicAnchorCountOffsetCommit}
                      disabled={isTransitionActive}
                    />
                  </div>

                  {/* 17章：絶対時間の補助表示（例：2曲目 8エイト目・3カウント目 → 1:54.0） */}
                  <p style={{ color: THEME.textDim }} className="text-[11px] leading-relaxed">
                    {formatMusicAnchorEighthCountLabel(effectiveMusicAnchor.eighthNumber, effectiveMusicAnchor.countOffset)}
                    {effectiveMusicAnchorTimeSec != null && (
                      <> → <span style={{ color: THEME.text, fontWeight: 700 }}>{formatTimePrecise(effectiveMusicAnchorTimeSec)}</span></>
                    )}
                  </p>

                  {/* 再生開始モード v1・STEP3・5章：手動Music Anchorに対する絶対的な再生指示のため、
                      手動Anchorが存在する構成（isMusicAnchorManual）だけに表示する。Auto Chainの
                      自動表示中は表示しない（自動Anchorを「手動に固定」した後に設定可能）。
                      2ボタンのsegmented control方式。現在値はgetMusicPlaybackStartMode(currentSlide)
                      から取得し、slide.musicPlaybackStartModeへ直接触れる箇所をここへ集約する。 */}
                  {isMusicAnchorManual &&
                    (() => {
                      const currentMode = getMusicPlaybackStartMode(currentSlide);
                      const modeBtnStyle = (active) => ({
                        background: active ? THEME.accent : THEME.panelBg2,
                        border: `1px solid ${active ? THEME.accent : THEME.border}`,
                        color: active ? "#141318" : THEME.text,
                        opacity: isTransitionActive ? 0.5 : 1,
                      });
                      return (
                        <div className="mt-0.5">
                          <p style={{ color: THEME.textDim }} className="text-[11px] font-bold mb-1">再生開始</p>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => setMusicPlaybackStartModeCommit("anchor")}
                              disabled={isTransitionActive}
                              title={isTransitionActive ? "再生中・一時停止中は変更できません" : "この構成のAnchor時刻から音楽と構成アニメーションを同時に開始します"}
                              style={modeBtnStyle(currentMode === "anchor")}
                              className="px-2 py-1 rounded-lg text-[11px] font-bold"
                            >
                              指定位置から
                            </button>
                            <button
                              type="button"
                              onClick={() => setMusicPlaybackStartModeCommit("sectionStart")}
                              disabled={isTransitionActive}
                              title={isTransitionActive ? "再生中・一時停止中は変更できません" : "楽曲セクションの開始位置から音楽を流し、この構成のAnchorで構成アニメーションを開始します"}
                              style={modeBtnStyle(currentMode === "sectionStart")}
                              className="px-2 py-1 rounded-lg text-[11px] font-bold"
                            >
                              曲頭から
                            </button>
                          </div>
                          {currentMode === "sectionStart" && (
                            <p style={{ color: THEME.textDim }} className="text-[10px] leading-relaxed mt-1">
                              曲頭から：この構成に入ると、楽曲セクションの開始位置から音楽を流し、指定カウントで構成が始まります。
                            </p>
                          )}
                        </div>
                      );
                    })()}

                  {/* 22〜24章（Music Anchor v1）→ 11章（Auto Chain v1）：警告のみ表示し、値は
                      自動補正しない。自動位置がSection境界を越えた場合は、Auto Chain v1・11章の
                      文言（次の構成へ手動Anchorを設定するよう促す）に切り替える。 */}
                  {musicAnchorDurationWarning && (
                    <p style={{ color: THEME.danger }} className="text-[11px] leading-relaxed">⚠ 音源の長さを超えています</p>
                  )}
                  {musicAnchorSectionBoundaryWarning && (
                    <p style={{ color: THEME.danger }} className="text-[11px] leading-relaxed">
                      {isMusicAnchorManual
                        ? "⚠ この位置は次の楽曲セクション開始後です"
                        : "⚠ 自動計算された音楽位置が次の楽曲セクション開始を超えています。必要に応じて次の構成へ手動Anchorを設定してください。"}
                    </p>
                  )}

                  <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                    {isMusicAnchorManual ? (
                      <button
                        type="button"
                        onClick={clearMusicAnchorCommit}
                        disabled={isTransitionActive}
                        title={isTransitionActive ? "再生中・一時停止中は変更できません" : undefined}
                        style={{ background: THEME.panelBg2, border: `1px solid ${THEME.danger}`, color: THEME.danger, opacity: isTransitionActive ? 0.5 : 1 }}
                        className="px-2 py-1 rounded-lg text-[11px] font-bold"
                      >
                        音楽位置を解除
                      </button>
                    ) : (
                      /* 16章：「この位置を手動Anchorにする」。今の自動計算結果をそのまま
                          slide.musicAnchorへ保存し、以後この構成より前のkeep/transition変更の
                          影響を受けないようにする。 */
                      <button
                        type="button"
                        onClick={promoteAutoMusicAnchorToManualCommit}
                        disabled={isTransitionActive}
                        title={isTransitionActive ? "再生中・一時停止中は変更できません" : "今の自動計算位置をこの構成の手動Anchorにします"}
                        style={{ background: THEME.panelBg2, border: `1px solid ${THEME.accent}`, color: THEME.accent, opacity: isTransitionActive ? 0.5 : 1 }}
                        className="px-2 py-1 rounded-lg text-[11px] font-bold"
                      >
                        手動に固定
                      </button>
                    )}
                    {/* 25章（任意機能）：現在の音楽再生位置から近似のエイト/カウントを逆算して設定する。
                        音源が読み込まれていない場合はmusicCurrentTimeが常に0でも安全（timeSecToSectionPosition
                        は0秒として扱うだけで、クラッシュはしない）。自動表示中に押した場合も
                        手動Anchorとして新規作成される。 */}
                    <button
                      type="button"
                      onClick={setMusicAnchorFromCurrentMusicTimeCommit}
                      disabled={isTransitionActive}
                      title={isTransitionActive ? "再生中・一時停止中は変更できません" : undefined}
                      style={{ background: THEME.panelBg2, border: `1px solid ${THEME.border}`, color: THEME.text, opacity: isTransitionActive ? 0.5 : 1 }}
                      className="px-2 py-1 rounded-lg text-[11px] font-bold"
                    >
                      現在の音楽位置から設定
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>

          <Divider />

          {/* 2. 出演者の追加 */}
          <section>
            <SectionTitle>出演者の追加</SectionTitle>
            <button
              onClick={addPerformer}
              disabled={performers.length >= MAX_PERFORMERS || isTransitionActive}
              title={isTransitionActive ? "再生中は出演者を追加できません" : undefined}
              style={{
                background: performers.length >= MAX_PERFORMERS || isTransitionActive ? THEME.borderSoft : THEME.accent,
                color: performers.length >= MAX_PERFORMERS || isTransitionActive ? THEME.textDim : "#141318",
              }}
              className="w-full mt-2 py-2 rounded-lg font-bold text-sm"
            >
              ＋ 出演者を追加
            </button>
            {/* 出演者一括追加 v1：既存の単体追加ボタンのすぐ下へ、控えめな「複数人追加」を追加。
                新しい常設パネルは作らず、押した時だけ小さなmodal（BulkAddPerformersModal）を開く。 */}
            <button
              onClick={() => setBulkAddPerformersOpen(true)}
              disabled={performers.length >= MAX_PERFORMERS || isTransitionActive}
              title={isTransitionActive ? "再生中は出演者を追加できません" : undefined}
              style={{
                border: `1px solid ${THEME.border}`,
                color: performers.length >= MAX_PERFORMERS || isTransitionActive ? THEME.textDim : THEME.text,
                background: "transparent",
                opacity: performers.length >= MAX_PERFORMERS || isTransitionActive ? 0.6 : 1,
              }}
              className="w-full mt-2 py-2 rounded-lg font-bold text-sm"
            >
              複数人追加
            </button>
          </section>

          <Divider />

          {/* 3. 出演者一覧 */}
          <section>
            <SectionTitle>出演者一覧（{performers.length} / {MAX_PERFORMERS}人）</SectionTitle>
            <div className="flex flex-col gap-1 mt-2 max-h-48 overflow-y-auto pr-1">
              {performers.map((p) => {
                const pos = placements[p.id];
                const warn = (pos && isBeyondAllAreas(pos, zones)) || overlapIds.has(p.id);
                const areaLabel = pos ? AREA_LABELS[pos.area] : null;
                const isSelected = selectedIds.includes(p.id);
                // 姿勢 v1.1・PART E：poseはperformerではなく現在slideのplacement側の属性のため、
                // ここでもgetPlacementPose(pos)で読む（未設定はstanding）。standingには何も表示せず、
                // kneelingの人だけ控えめなバッジを表示する。
                const isKneeling = pos && getPlacementPose(pos) === POSE_KNEELING;
                return (
                  <button
                    key={p.id}
                    onClick={(e) => (e.shiftKey ? toggleSelect(p.id) : selectOnly(p.id))}
                    style={{
                      background: isSelected ? THEME.panelBg2 : "transparent",
                      border: `1px solid ${isSelected ? THEME.accent : "transparent"}`,
                    }}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-sm"
                  >
                    <span style={{ width: 16, height: 16, borderRadius: 999, background: p.color, flexShrink: 0 }} />
                    {/* 出演者名 v1・5章：番号のすぐ右に、設定されていれば控えめなスタイルで表示する。
                        番号＋名前をまとめてflex:1（残り幅を伸縮的に使う領域）にし、片膝バッジ・
                        待機エリア・身長（すべてshrink-0で固定幅）を右側へ押し出す既存レイアウトは
                        維持する。名前はellipsisで安全に省略し、既存情報を隠さないようにする（9章）。 */}
                    <span style={{ flex: 1, display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
                      <span style={{ flexShrink: 0 }}>{p.number}番</span>
                      {getPerformerName(p) && (
                        <span
                          style={{ color: THEME.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}
                          className="text-xs"
                        >
                          {getPerformerName(p)}
                        </span>
                      )}
                    </span>
                    {/* 姿勢 v1.1・PART E：既存の待機エリア表示（areaLabel）とは別の要素として、
                        「片膝」だけ小さな縁取りバッジで表示する（3章：既存の待機エリア表示は
                        絶対に壊さない。番号→片膝バッジ→待機エリア→身長、の優先順で並べる）。
                        枠線付きにすることで、色だけのareaLabel（テキストのみ）と見分けやすくする。 */}
                    {isKneeling && (
                      <span
                        style={{
                          color: THEME.accent,
                          border: `1px solid ${THEME.accent}`,
                          borderRadius: 4,
                          padding: "0 4px",
                          lineHeight: "14px",
                          whiteSpace: "nowrap",
                        }}
                        className="text-[10px] font-bold shrink-0"
                      >
                        片膝
                      </span>
                    )}
                    {areaLabel && areaLabel !== "ステージ上" && (
                      <span style={{ color: THEME.accent }} className="text-[10px] shrink-0">{areaLabel}</span>
                    )}
                    <span style={{ color: THEME.textDim }} className="text-xs shrink-0">{p.height}cm</span>
                    {warn && <span style={{ color: THEME.danger }}>⚠</span>}
                  </button>
                );
              })}
              {performers.length === 0 && (
                <p style={{ color: THEME.textDim }} className="text-xs">まだ出演者がいません。「＋ 出演者を追加」で追加してください。</p>
              )}
            </div>
          </section>

          <Divider />

          {/* 4. 選択中の出演者編集 */}
          <section>
            <SectionTitle>
              選択中の出演者{isMultiSelect ? `（${selectedIds.length}人）` : ""}
            </SectionTitle>
            {selectedIds.length === 0 && (
              <p style={{ color: THEME.textDim }} className="text-xs mt-2">
                ステージ上の出演者、または上のリストから選択してください（Shift＋クリックで複数選択）。
              </p>
            )}

            {isMultiSelect && (() => {
              const areaSet = new Set(selectedIds.map((id) => (placements[id] ? placements[id].area : null)));
              const commonArea = areaSet.size === 1 ? [...areaSet][0] : "";
              const selectedXs = new Set(selectedIds.map((id) => (placements[id] ? placements[id].x : null)));
              const selectedYs = new Set(selectedIds.map((id) => (placements[id] ? placements[id].y : null)));
              const commonX = selectedXs.size === 1 ? [...selectedXs][0] : null;
              const commonY = selectedYs.size === 1 ? [...selectedYs][0] : null;
              const selectedColors = new Set(
                selectedIds.map((id) => {
                  const p = performers.find((pp) => pp.id === id);
                  return p ? p.color : null;
                })
              );
              const commonColor = selectedColors.size === 1 ? [...selectedColors][0] : null;
              // 身長設定 v2：UIの3ボタン（小・中・大）は実際のheight値ではなく、getHeightPreset()で
              // 求めた「最も近いpreset」を基準にactive判定する（PART N：旧150/175でも自然に
              // どれかのボタンがactiveになるようにするため）。複数選択時のmixed state判定も
              // 既存のcommonColor等と同じSetパターンをそのまま踏襲する（PART P）。
              const selectedHeightPresets = new Set(selectedIds.map((id) => getHeightPreset(performers.find((pp) => pp.id === id)?.height)));
              const commonHeightPreset = selectedHeightPresets.size === 1 ? [...selectedHeightPresets][0] : null;
              // 姿勢 v1：performerではなくplacement（現在の構成）側の属性のため、selectedIdsを
              // 「現在slideのplacements」から引いて姿勢の共通性を判定する（commonColor/commonHeightと
              // 同じ考え方）。
              const selectedPoses = new Set(
                selectedIds.map((id) => (placements[id] ? getPlacementPose(placements[id]) : null))
              );
              const commonPose = selectedPoses.size === 1 ? [...selectedPoses][0] : null;
              return (
                <div className="flex flex-col gap-3 mt-2">
                  <div className="flex items-center justify-between gap-2">
                    <p style={{ color: THEME.textDim }} className="text-xs">
                      {selectedIds.length}人を選択中です。ドラッグすると相対位置を保ったまま一緒に移動します。
                    </p>
                    <InfoToggle open={!!descOpen.multiSelectHelp} onToggle={() => toggleDesc("multiSelectHelp")} />
                  </div>

                  <div className="flex items-center gap-2">
                    <label style={{ color: THEME.textDim }} className="text-xs w-16 shrink-0">色</label>
                    <input
                      type="color"
                      value={commonColor || "#888888"}
                      onFocus={beginEdit}
                      onChange={(e) => applyPerformerPatchLive(selectedIds, { color: e.target.value })}
                      onBlur={endEdit}
                      style={{ width: 44, height: 30, background: "transparent", border: `1px solid ${THEME.border}`, borderRadius: 6, padding: 2 }}
                    />
                    <div className="flex gap-1 flex-wrap items-center">
                      {DEFAULT_COLORS.slice(0, 6).map((c) => (
                        <button
                          key={c}
                          onClick={() => applyPerformerPatchCommit(selectedIds, { color: c })}
                          style={{ width: 18, height: 18, borderRadius: 999, background: c, border: c === commonColor ? `2px solid ${THEME.text}` : "1px solid transparent" }}
                        />
                      ))}
                      {commonColor == null && (
                        <span style={{ color: THEME.textDim }} className="text-[11px]">（複数の値）</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <label style={{ color: THEME.textDim }} className="text-xs w-16 shrink-0">身長</label>
                    <div className="flex gap-2 items-center">
                      {HEIGHT_PRESETS.map((h) => (
                        <button
                          key={h}
                          onClick={() => applyPerformerPatchCommit(selectedIds, { height: h })}
                          style={{
                            background: commonHeightPreset === h ? THEME.accent : THEME.panelBg2,
                            color: commonHeightPreset === h ? "#141318" : THEME.text,
                            border: `1px solid ${THEME.border}`,
                          }}
                          className="px-3 py-1 rounded text-sm font-bold"
                        >
                          {HEIGHT_PRESET_LABELS[h]}
                        </button>
                      ))}
                      {commonHeightPreset == null && (
                        <span style={{ color: THEME.textDim }} className="text-[11px]">（複数の値）</span>
                      )}
                    </div>
                  </div>
                  {/* 姿勢 v1：現在の構成に限り、選択中の全員へまとめて反映する（1回のcommitWork＝Undo 1件）。
                      将来の身長3段階化に備え、身長ボタン列と同じ幅感のシンプルな2択に留める。 */}
                  <div className="flex items-center gap-2">
                    <label style={{ color: THEME.textDim }} className="text-xs w-16 shrink-0">姿勢</label>
                    <div className="flex gap-2 items-center">
                      <button
                        type="button"
                        onClick={() => setPerformersPoseCommit(selectedIds, POSE_STANDING)}
                        disabled={isTransitionActive}
                        style={{
                          background: commonPose === POSE_STANDING ? THEME.accent : THEME.panelBg2,
                          color: commonPose === POSE_STANDING ? "#141318" : THEME.text,
                          border: `1px solid ${THEME.border}`,
                          opacity: isTransitionActive ? 0.5 : 1,
                        }}
                        className="px-3 py-1 rounded text-sm font-bold"
                      >
                        立ち
                      </button>
                      <button
                        type="button"
                        onClick={() => setPerformersPoseCommit(selectedIds, POSE_KNEELING)}
                        disabled={isTransitionActive}
                        style={{
                          background: commonPose === POSE_KNEELING ? THEME.accent : THEME.panelBg2,
                          color: commonPose === POSE_KNEELING ? "#141318" : THEME.text,
                          border: `1px solid ${THEME.border}`,
                          opacity: isTransitionActive ? 0.5 : 1,
                        }}
                        className="px-3 py-1 rounded text-sm font-bold"
                      >
                        片膝
                      </button>
                      {commonPose == null && (
                        <span style={{ color: THEME.textDim }} className="text-[11px]">（複数の値）</span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <label style={{ color: THEME.textDim }} className="text-xs w-16 shrink-0">横位置</label>
                    <input
                      type="number"
                      step={0.25}
                      placeholder={commonX == null ? "複数の値" : undefined}
                      value={commonX == null ? "" : commonX}
                      disabled={isTransitionActive}
                      onFocus={beginEdit}
                      onChange={(e) => {
                        if (e.target.value === "") return;
                        applyBulkAxisLive(selectedIds, "x", Number(e.target.value) || 0);
                      }}
                      onBlur={endEdit}
                      onKeyDown={commitOnEnter}
                      style={inputStyle}
                      className="w-full rounded px-2 py-1 text-sm"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <label style={{ color: THEME.textDim }} className="text-xs w-16 shrink-0">縦位置</label>
                    <input
                      type="number"
                      step={0.25}
                      placeholder={commonY == null ? "複数の値" : undefined}
                      value={commonY == null ? "" : commonY}
                      disabled={isTransitionActive}
                      onFocus={beginEdit}
                      onChange={(e) => {
                        if (e.target.value === "") return;
                        applyBulkAxisLive(selectedIds, "y", Number(e.target.value) || 0);
                      }}
                      onBlur={endEdit}
                      onKeyDown={commitOnEnter}
                      style={inputStyle}
                      className="w-full rounded px-2 py-1 text-sm"
                    />
                  </div>
                  {descOpen.multiSelectHelp && (
                    <p style={{ color: THEME.textDim }} className="text-[11px] leading-relaxed">
                      横位置／縦位置は、選択中の全員が同じ値のときだけ数値を表示します（異なる場合は「複数の値」）。
                      どちらかへ数値を入力すると、その軸だけ全員に反映し、もう一方の軸は各自の値を維持します。
                    </p>
                  )}

                  <div className="flex items-center gap-2">
                    <label style={{ color: THEME.textDim }} className="text-xs w-16 shrink-0">エリア</label>
                    <select
                      value={commonArea || ""}
                      onChange={(e) => moveIdsToArea(selectedIds, e.target.value)}
                      disabled={isTransitionActive}
                      style={inputStyle}
                      className="w-full rounded px-2 py-1 text-sm"
                    >
                      <option value="" disabled>
                        {areaSet.size > 1 ? "（複数のエリア）" : "選択してください"}
                      </option>
                      {AREA_ORDER.map((key) => (
                        <option key={key} value={key}>
                          {AREA_LABELS[key]}
                        </option>
                      ))}
                    </select>
                  </div>
                  {descOpen.multiSelectHelp && (
                    <p style={{ color: THEME.textDim }} className="text-[11px] leading-relaxed">
                      エリアを選ぶと、選択中の全員が番号順にそのエリアの中央付近へ0.5単位で並びます（移動後も個別にドラッグして調整できます）。
                    </p>
                  )}

                  <button
                    type="button"
                    onClick={() => setBulkDeleteConfirmOpen(true)}
                    disabled={isTransitionActive}
                    style={{
                      border: `1px solid ${THEME.danger}`,
                      color: THEME.danger,
                      opacity: isTransitionActive ? 0.5 : 1,
                      cursor: isTransitionActive ? "not-allowed" : "pointer",
                    }}
                    className="mt-1 py-1.5 rounded-lg text-sm font-bold"
                  >
                    選択中の出演者を削除
                  </button>
                  <button
                    onClick={() => setSelectedIds([])}
                    style={{ border: `1px solid ${THEME.border}`, color: THEME.text }}
                    className="py-1.5 rounded-lg text-sm font-bold"
                  >
                    選択を解除
                  </button>
                </div>
              );
            })()}

            {selectedPerformer && selectedPos && (
              <div className="flex flex-col gap-3 mt-2">
                <div className="flex items-center gap-2">
                  <label style={{ color: THEME.textDim }} className="text-xs w-16 shrink-0">番号</label>
                  <input
                    type="number"
                    value={selectedPerformer.number}
                    onFocus={beginEdit}
                    onChange={(e) => updatePerformerLive(selectedPerformer.id, { number: Number(e.target.value) || 0 })}
                    onBlur={endEdit}
                    onKeyDown={commitOnEnter}
                    style={inputStyle}
                    className="w-full rounded px-2 py-1 text-sm"
                  />
                </div>
                {/* 出演者名 v1：performer.name（任意・省略可）。入力中はupdatePerformerLive、
                    フォーカスが外れた時点でendEdit（beginWorkBatch/endWorkBatchによる
                    1回のUndoへのまとめ）という、番号入力欄と全く同じcommit方式を再利用する
                    （17章：1文字ごとにUndo履歴を積まないため）。
                    v1.1・PART B・S：新規入力・編集の上限は5文字（PERFORMER_NAME_INPUT_MAX_CHARS）。
                    HTMLのmaxLengthは「新しいキー入力を止める」だけで、既存の6文字以上のnameを
                    programmaticに切り詰めることはない（value自体は変更しない）ため、旧データは
                    そのままこの欄に表示され続け、ユーザーが実際に編集した時点で自然に5文字以内へ
                    収まる、という安全な挙動になる（データの強制migrationはしない）。 */}
                <div className="flex items-center gap-2">
                  <label style={{ color: THEME.textDim }} className="text-xs w-16 shrink-0">名前</label>
                  <input
                    type="text"
                    value={selectedPerformer.name || ""}
                    placeholder="（任意・最大5文字）"
                    maxLength={PERFORMER_NAME_INPUT_MAX_CHARS}
                    onFocus={beginEdit}
                    onChange={(e) => updatePerformerLive(selectedPerformer.id, { name: e.target.value })}
                    onBlur={endEdit}
                    onKeyDown={commitOnEnter}
                    style={inputStyle}
                    className="w-full rounded px-2 py-1 text-sm"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label style={{ color: THEME.textDim }} className="text-xs w-16 shrink-0">色</label>
                  <input
                    type="color"
                    value={selectedPerformer.color}
                    onFocus={beginEdit}
                    onChange={(e) => updatePerformerLive(selectedPerformer.id, { color: e.target.value })}
                    onBlur={endEdit}
                    style={{ width: 44, height: 30, background: "transparent", border: `1px solid ${THEME.border}`, borderRadius: 6, padding: 2 }}
                  />
                  <div className="flex gap-1 flex-wrap">
                    {DEFAULT_COLORS.slice(0, 6).map((c) => (
                      <button
                        key={c}
                        onClick={() => updatePerformerCommit(selectedPerformer.id, { color: c })}
                        style={{ width: 18, height: 18, borderRadius: 999, background: c, border: c === selectedPerformer.color ? `2px solid ${THEME.text}` : "1px solid transparent" }}
                      />
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <label style={{ color: THEME.textDim }} className="text-xs w-16 shrink-0">身長</label>
                  <div className="flex gap-2">
                    {HEIGHT_PRESETS.map((h) => (
                      <button
                        key={h}
                        onClick={() => updatePerformerCommit(selectedPerformer.id, { height: h })}
                        style={{
                          background: getHeightPreset(selectedPerformer.height) === h ? THEME.accent : THEME.panelBg2,
                          color: getHeightPreset(selectedPerformer.height) === h ? "#141318" : THEME.text,
                          border: `1px solid ${THEME.border}`,
                        }}
                        className="px-3 py-1 rounded text-sm font-bold"
                      >
                        {HEIGHT_PRESET_LABELS[h]}
                      </button>
                    ))}
                  </div>
                </div>
                {/* 身長設定 v2・PART K：普段は閉じている「？説明を見る」に、小・中・大それぞれの
                    目安cmと、この設定の位置づけ（正確なプロフィール管理ではない）を説明する。 */}
                <div className="flex items-center justify-end -mt-1">
                  <InfoToggle open={!!descOpen.heightPreset} onToggle={() => toggleDesc("heightPreset")} />
                </div>
                {descOpen.heightPreset && (
                  <p style={{ color: THEME.textDim }} className="text-[11px] leading-relaxed -mt-1">
                    小：約155cm／中：約170cm／大：約185cm の目安です。俯瞰客席ビューでのおおよその体格差を確認するための設定で、出演者の正確な身長プロフィールを管理する機能ではありません。
                  </p>
                )}

                {/* 姿勢 v1：performerではなくplacement（現在の構成）側の属性なので、selectedPos.pose
                    （未設定はgetPlacementPoseがstandingとして扱う）を見て2択ボタンで切り替える。 */}
                <div className="flex items-center gap-2">
                  <label style={{ color: THEME.textDim }} className="text-xs w-16 shrink-0">姿勢</label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setPerformersPoseCommit([selectedPerformer.id], POSE_STANDING)}
                      disabled={isTransitionActive}
                      style={{
                        background: getPlacementPose(selectedPos) === POSE_STANDING ? THEME.accent : THEME.panelBg2,
                        color: getPlacementPose(selectedPos) === POSE_STANDING ? "#141318" : THEME.text,
                        border: `1px solid ${THEME.border}`,
                        opacity: isTransitionActive ? 0.5 : 1,
                      }}
                      className="px-3 py-1 rounded text-sm font-bold"
                    >
                      立ち
                    </button>
                    <button
                      type="button"
                      onClick={() => setPerformersPoseCommit([selectedPerformer.id], POSE_KNEELING)}
                      disabled={isTransitionActive}
                      style={{
                        background: getPlacementPose(selectedPos) === POSE_KNEELING ? THEME.accent : THEME.panelBg2,
                        color: getPlacementPose(selectedPos) === POSE_KNEELING ? "#141318" : THEME.text,
                        border: `1px solid ${THEME.border}`,
                        opacity: isTransitionActive ? 0.5 : 1,
                      }}
                      className="px-3 py-1 rounded text-sm font-bold"
                    >
                      片膝
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <label style={{ color: THEME.textDim }} className="text-xs w-16 shrink-0">横位置</label>
                  <input
                    type="number"
                    step={0.25}
                    min={zones.stageLeft.xMin}
                    max={zones.stageRight.xMax}
                    value={selectedPos.x}
                    disabled={isTransitionActive}
                    onFocus={beginEdit}
                    onChange={(e) => setPlacementLive(selectedPerformer.id, Number(e.target.value) || 0, selectedPos.y, true)}
                    onBlur={endEdit}
                    onKeyDown={commitOnEnter}
                    style={inputStyle}
                    className="w-full rounded px-2 py-1 text-sm"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label style={{ color: THEME.textDim }} className="text-xs w-16 shrink-0">縦位置</label>
                  <input
                    type="number"
                    step={0.25}
                    min={0}
                    max={zones.upstageBackstage.yMax}
                    value={selectedPos.y}
                    disabled={isTransitionActive}
                    onFocus={beginEdit}
                    onChange={(e) => setPlacementLive(selectedPerformer.id, selectedPos.x, Number(e.target.value) || 0, true)}
                    onBlur={endEdit}
                    onKeyDown={commitOnEnter}
                    style={inputStyle}
                    className="w-full rounded px-2 py-1 text-sm"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <label style={{ color: THEME.textDim }} className="text-xs w-16 shrink-0">エリア</label>
                  <select
                    value={selectedPos.area || ""}
                    onChange={(e) => moveIdsToArea([selectedPerformer.id], e.target.value)}
                    disabled={isTransitionActive}
                    style={inputStyle}
                    className="w-full rounded px-2 py-1 text-sm"
                  >
                    {selectedPos.area == null && (
                      <option value="" disabled>
                        範囲外（要注意）
                      </option>
                    )}
                    {AREA_ORDER.map((key) => (
                      <option key={key} value={key}>
                        {AREA_LABELS[key]}
                      </option>
                    ))}
                  </select>
                </div>

                {isBeyondAllAreas(selectedPos, zones) && (
                  <div style={{ color: THEME.danger }} className="text-xs flex items-center justify-between gap-2">
                    <span>⚠ ステージ・袖・待機エリアの外側です</span>
                    <button
                      onClick={() => returnToStage(selectedPerformer.id)}
                      disabled={isTransitionActive}
                      style={{ background: THEME.danger, color: "#141318", opacity: isTransitionActive ? 0.5 : 1 }}
                      className="px-2 py-1 rounded font-bold"
                    >
                      ステージ内に戻す
                    </button>
                  </div>
                )}
                {overlapIds.has(selectedPerformer.id) && (
                  <div style={{ color: THEME.danger }} className="text-xs">⚠ 他の出演者と位置が重なっています</div>
                )}

                <button
                  onClick={() => deletePerformer(selectedPerformer.id)}
                  disabled={isTransitionActive}
                  style={{
                    border: `1px solid ${THEME.danger}`,
                    color: THEME.danger,
                    opacity: isTransitionActive ? 0.5 : 1,
                    cursor: isTransitionActive ? "not-allowed" : "pointer",
                  }}
                  className="mt-1 py-1.5 rounded-lg text-sm font-bold"
                >
                  この出演者を削除
                </button>
              </div>
            )}
          </section>
          </CollapsibleGroup>

          <Divider />
          {/* 5. 現在の状態表示 */}
          <p style={{ color: THEME.textDim }} className="text-[11px] leading-relaxed">
            現在の視点：{viewMode === "top" ? "平面図（真上）" : "俯瞰客席ビュー"} ／ 選択中：
            {selectedIds.length === 0 && "なし"}
            {selectedPerformer && `${selectedPerformer.number}番`}
            {isMultiSelect && `${selectedIds.length}人`}
          </p>
        </aside>
      </div>

      {/* 構成一覧：通常モード（カードクリック→goToSlide→モーダルを閉じる。17章：従来通り）と、
          Export Center v1の出力用選択モード（カードクリックで選択ON/OFF。goToSlideしない・
          モーダルを閉じない＝6章）を、同じSlideListModalコンポーネントのmode切替で提供する
          （5章：別コンポーネントへ複製しない）。両モードのopen stateは互いに独立しており、
          同時にtrueにはならない想定（通常の「一覧表示」ボタンとExport Centerの「構成を選択」は
          別々の入口のため）。 */}
      {(slideListOpen || exportSlidePickerOpen) && (
        <SlideListModal
          mode={exportSlidePickerOpen ? "export-selection" : "normal"}
          slides={slides}
          performers={performers}
          stage={stage}
          zones={zones}
          currentSlideIndex={currentSlideIndex}
          isTransitionActive={isTransitionActive}
          onSelectSlide={goToSlide}
          onClose={exportSlidePickerOpen ? closeExportSlidePicker : () => setSlideListOpen(false)}
          musicSections={musicSections}
          transitionCounts={transitionCounts}
          selectedSlideIds={selectedExportSlideIds}
          onToggleSlideSelection={toggleExportSlideSelection}
          onSelectAllSlides={selectAllExportSlides}
          onClearSlideSelection={clearExportSlideSelection}
          onDuplicateSlide={duplicateSlideAt}
          onRequestDeleteSlide={(index) => setSlideDeleteTargetIndex(index)}
          onReorderSlide={moveSlide}
          canDeleteSlide={slides.length > 1}
          copiedSlideId={copiedSlideId}
          onCopySlide={copySlideAt}
          onPasteSlideAfter={pasteAfterIndexUnified}
          onClearCopiedSlide={clearCopiedSlide}
          recentlyPastedSlideId={recentlyPastedSlideId}
          hasBulkClipboard={hasBulkClipboard}
          selectedCopySlideIds={selectedCopySlideIds}
          onToggleCopySlideSelection={toggleCopySlideSelection}
          onSelectAllCopySlides={selectAllCopySlides}
          onClearCopySlideSelection={clearCopySlideSelection}
          onBulkCopySlides={copySelectedSlides}
          onRequestBulkDelete={requestBulkSlideDelete}
          pendingBulkDeleteIds={pendingBulkSlideDeleteIds}
          onConfirmBulkDelete={confirmBulkSlideDelete}
          onCancelBulkDelete={cancelBulkSlideDelete}
        />
      )}

      {/* Export Center v1：出力の入口モーダル。「現在の構成／構成を選択／すべての構成」・
          表示オプション（待機エリア・移動軌跡）・ビュー（現在のビュー／平面図／俯瞰客席）を
          選び、既存のExport基盤（buildFormationExportModel(s)・renderFormationExportToCanvas・
          downloadCanvasAsPng）でPNGを生成する。work/slides/Undo履歴には一切関与しない（21章）。 */}
      {exportCenterOpen && (
        <ExportCenterModal
          onClose={closeExportCenter}
          targetMode={exportTargetMode}
          onTargetModeChange={setExportTargetMode}
          onOpenSlidePicker={openExportSlidePicker}
          selectedCount={selectedExportSlideIds.length}
          totalSlideCount={slides.length}
          currentSlideNumber={currentSlideIndex + 1}
          showWaitingAreas={exportShowWaitingAreas}
          onShowWaitingAreasChange={setExportShowWaitingAreas}
          showTrajectory={exportShowTrajectory}
          onShowTrajectoryChange={setExportShowTrajectory}
          trajectoryMode={exportTrajectoryMode}
          onTrajectoryModeChange={setExportTrajectoryMode}
          showPerformerNames={exportShowPerformerNames}
          onShowPerformerNamesChange={setExportShowPerformerNames}
          showMusicTime={exportShowMusicTime}
          onShowMusicTimeChange={setExportShowMusicTime}
          displayScale={exportDisplayScale}
          onDisplayScaleChange={setExportDisplayScale}
          viewChoice={exportViewChoice}
          onViewChoiceChange={setExportViewChoice}
          currentViewLabel={viewMode === "front" ? "俯瞰客席" : "平面図"}
          format={exportFormat}
          onFormatChange={setExportFormat}
          busy={exportBatchBusy}
          error={pngExportError}
          onDismissError={() => setPngExportError(null)}
          onConfirmExport={handleExportCenterConfirm}
          confirmDisabled={exportConfirmDisabled}
          confirmLabel={exportConfirmLabel}
        />
      )}

      {/* 複数選択時の「選択中の出演者を削除」確認モーダル（window.confirmは使わない） */}
      {bulkDeleteConfirmOpen && (
        <ConfirmDeleteModal
          count={selectedIds.length}
          onConfirm={() => {
            deletePerformers(selectedIds);
            setBulkDeleteConfirmOpen(false);
          }}
          onCancel={() => setBulkDeleteConfirmOpen(false)}
        />
      )}

      {/* 出演者一括追加 v1：「何人追加しますか？」の小さなmodal（window.confirmは使わない）。
          MAX_PERFORMERSに基づく上限はmodal側で表示・clampし、実際の追加はaddPerformersBulk()
          （1回のcommitWork＝Undo 1件）へ委譲する。 */}
      {bulkAddPerformersOpen && (
        <BulkAddPerformersModal
          currentCount={performers.length}
          maxCount={MAX_PERFORMERS}
          onConfirm={(count) => {
            addPerformersBulk(count);
            setBulkAddPerformersOpen(false);
          }}
          onCancel={() => setBulkAddPerformersOpen(false)}
        />
      )}

      {/* 構成削除の確認モーダル（window.confirmは使わない）。構成一覧v2・第1段階：
          下部操作バーの削除ボタン・キーボード（Delete/Backspace）・構成一覧の「…」メニューの
          いずれから開いても、この1つのモーダルとslideDeleteTargetIndex（対象index）だけで
          完結する（別の削除確認UIを新設しない）。 */}
      {slideDeleteTargetIndex !== null && slides[slideDeleteTargetIndex] && (
        <ConfirmDeleteSlideModal
          slideName={slides[slideDeleteTargetIndex].name}
          onConfirm={() => {
            deleteSlideAt(slideDeleteTargetIndex);
            setSlideDeleteTargetIndex(null);
          }}
          onCancel={() => setSlideDeleteTargetIndex(null)}
        />
      )}

      {/* Project間コピー v1・5章：Ctrl+VがProject間コピーと判定し、かつ貼り付け先Projectに
          number+name一致の出演者がいない人がいた場合だけ表示する確認モーダル。
          「そのまま貼り付ける」でconfirmCrossProjectPaste（実際の挿入）、「キャンセル」/背景クリックで
          cancelCrossProjectPaste（workは一切変更しない）を呼ぶ。 */}
      {pendingCrossProjectPaste && (
        <CrossProjectPasteWarningModal
          unmatchedPerformers={pendingCrossProjectPaste.unmatchedSourcePerformers}
          isBulkPaste={Array.isArray(pendingCrossProjectPaste.sourceSlides)}
          onConfirm={confirmCrossProjectPaste}
          onCancel={cancelCrossProjectPaste}
        />
      )}

      {/* Multi Project：プロジェクト削除の確認モーダル（window.confirmは使わない） */}
      {projectDeleteTarget && (
        <ConfirmDeleteProjectModal
          projectName={projectDeleteTarget.name}
          onConfirm={() => deleteProject(projectDeleteTarget.id)}
          onCancel={() => setProjectDeleteTargetId(null)}
        />
      )}

      {/* Project Backup v1：書き出し／読み込みの結果・エラー案内用モーダル。
          新しいトースト通知基盤は追加せず、既存の確認モーダル群と同じ見た目に揃える。 */}
      {projectBackupMessage && (
        <ProjectBackupMessageModal
          tone={projectBackupMessage.tone}
          text={projectBackupMessage.text}
          onClose={() => setProjectBackupMessage(null)}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// 小さな共通UIパーツ
// ------------------------------------------------------------------
const inputStyle = {
  background: THEME.panelBg2,
  border: `1px solid ${THEME.border}`,
  color: THEME.text,
};

function SectionTitle({ children }) {
  return (
    <h2 style={{ color: THEME.text, borderLeft: `3px solid ${THEME.accent}` }} className="text-sm font-bold pl-2">
      {children}
    </h2>
  );
}

function Divider() {
  return <div style={{ height: 1, background: THEME.borderSoft }} />;
}

// 右編集パネルの整理 v1（PART D）：「全体の設定」「構成ごとの設定」の2グループを
// 開閉可能にするための共通コンテナ。初見ユーザーでも「これは作品全体の設定」「これは今選んでいる
// 構成の設定」と一目で分かるよう、薄い背景・border・見出しでグループの境界を示す（18章）。
// 派手な演出は避け、既存のTHEMEカラーパレットのみを使う。閉じている間は中身を一切renderしない
// （19章：開く/閉じるができれば十分で、高さアニメーション等は今回作らない）。
//
// スクロール修正メモ（今回）：以前ここに className="overflow-hidden" を付けていたのが、
// サイドバー下部へスクロールできなくなっていた直接の原因だった。.slsim-sidebar は
// display:flex; flex-direction:column; overflow-y:auto という「自分自身がscroll container」に
// なっているが、CSS Flexboxの仕様上、overflowがvisible以外の子要素は「flexアイテムとしての
// 自動最小サイズ」がその子の内容量（min-content）ではなく0として扱われる。そのため、
// サイドバーの高さが足りない場面で、このCollapsibleGroup（特に内容が長い「構成ごとの設定」）が
// 自然な内容の高さより縮められ、かつoverflow:hiddenによりはみ出した中身がそのまま
// 見えなくなる（＝サイドバー自身のscrollHeightが増えず、overflow-y:autoのスクロールバーが
// 効かない）という不具合になっていた。
// 修正：overflow-hiddenを外し、flexShrink:0を明示することで、このグループがサイドバーの
// flexレイアウト内で縮められることなく常に内容の自然な高さを保つようにした。これにより、
// 複数グループぶんの合計の高さがサイドバーの表示領域を超えたとき、責任を持つのは
// 常に親の.slsim-sidebar（overflow-y:auto）だけになり、CollapsibleGroup自身はサイドバー全体の
// scrollを止めるようなoverflow設定を一切持たない（5章の推奨構造）。
function CollapsibleGroup({ title, icon, open, onToggle, children }) {
  return (
    <div
      style={{ background: THEME.panelBg, border: `1px solid ${THEME.border}`, borderRadius: 12, flexShrink: 0 }}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{ color: THEME.text, background: "transparent" }}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
        aria-expanded={open}
      >
        <span style={{ color: THEME.accent, width: 12, flexShrink: 0 }} className="text-[10px]">{open ? "▼" : "▶"}</span>
        {icon && <span className="shrink-0">{icon}</span>}
        <span className="text-sm font-bold flex-1">{title}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 flex flex-col gap-3" style={{ borderTop: `1px solid ${THEME.borderSoft}`, paddingTop: 10 }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// Multi Project / Workspace v1：Project Switcher
// ------------------------------------------------------------------
// ヘッダー左側（アプリ名の隣）に置く、コンパクトなProject切替UI。
// 「現在Project名 ▼」ボタンを押すとドロップダウンメニューが開き、
//   ・Project一覧（クリックで切替、✓は現在アクティブなもの）
//   ・＋ 新しいプロジェクト / プロジェクトを複製 / 名前を変更 / プロジェクトを削除
// を表示する（4章）。大きなProject管理画面は今回作らない（4章：v1範囲外）。
//
// renamingId !== null の間だけ、対象Projectの行がテキスト入力に切り替わる
// （インライン改名。専用モーダルは作らない＝既存UI思想に合わせて最小構成にする）。
function ProjectSwitcher({
  projects,
  activeProjectId,
  activeProjectName,
  open,
  disabled,
  renamingId,
  onToggleOpen,
  onClose,
  onSelectProject,
  onCreateProject,
  onDuplicateProject,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onRequestDelete,
  onExportProject,
  onImportProject,
}) {
  const [renameDraft, setRenameDraft] = useState("");

  useEffect(() => {
    if (renamingId) {
      const target = projects.find((p) => p.id === renamingId);
      setRenameDraft(target ? target.name : "");
    }
  }, [renamingId, projects]);

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        onClick={onToggleOpen}
        disabled={disabled}
        title={disabled ? "再生中はプロジェクトを切り替えられません" : "プロジェクトを切り替え"}
        aria-haspopup="true"
        aria-expanded={open}
        style={{
          background: THEME.panelBg2,
          color: disabled ? THEME.textDim : THEME.text,
          border: `1px solid ${THEME.border}`,
          opacity: disabled ? 0.6 : 1,
          cursor: disabled ? "not-allowed" : "pointer",
          maxWidth: 220,
        }}
        className="px-3 py-1.5 rounded-lg text-sm font-bold flex items-center gap-1.5"
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 160,
            display: "inline-block",
          }}
        >
          {activeProjectName}
        </span>
        <span style={{ fontSize: 10 }}>▼</span>
      </button>

      {open && (
        <>
          {/* 外側クリックで閉じるための透明オーバーレイ（他モーダルのonClick=onCancel方式と同じ考え方） */}
          <div
            onClick={onClose}
            style={{ position: "fixed", inset: 0, zIndex: 219, background: "transparent" }}
          />
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              left: 0,
              zIndex: 220,
              background: THEME.panelBg,
              border: `1px solid ${THEME.border}`,
              borderRadius: 12,
              minWidth: 240,
              maxWidth: 320,
              maxHeight: 360,
              overflowY: "auto",
              boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
              padding: 6,
            }}
          >
            {projects.map((p) => {
              const isActive = p.id === activeProjectId;
              const isRenaming = renamingId === p.id;
              return (
                <div
                  key={p.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "6px 8px",
                    borderRadius: 8,
                    background: isActive ? THEME.panelBg2 : "transparent",
                  }}
                  className="text-sm"
                >
                  {isRenaming ? (
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          // Project名 v1.1・PART B・C：IME（日本語入力等）変換確定のEnterでは
                          // ここでrenameを確定させない（isImeComposingEvent参照。変換確定後、
                          // もう一度Enterを押した時だけ通常通りcommitする）。
                          if (isImeComposingEvent(e)) return;
                          e.preventDefault();
                          onCommitRename(p.id, renameDraft);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          onCancelRename();
                        }
                      }}
                      onBlur={() => onCommitRename(p.id, renameDraft)}
                      style={{ ...inputStyle, flex: 1, borderRadius: 6, padding: "2px 6px" }}
                    />
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => onSelectProject(p.id)}
                        title={p.name}
                        style={{
                          flex: 1,
                          textAlign: "left",
                          background: "transparent",
                          border: "none",
                          color: THEME.text,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          cursor: "pointer",
                        }}
                      >
                        {p.name}
                      </button>
                      {isActive && <span style={{ color: THEME.accent }}>✓</span>}
                      <button
                        type="button"
                        title="名前を変更"
                        aria-label="名前を変更"
                        onClick={() => onStartRename(p.id)}
                        style={{ background: "transparent", border: "none", color: THEME.textDim, cursor: "pointer", fontSize: 12 }}
                      >
                        ✎
                      </button>
                    </>
                  )}
                </div>
              );
            })}

            <div style={{ height: 1, background: THEME.border, margin: "6px 2px" }} />

            <button
              type="button"
              onClick={onCreateProject}
              style={{ background: "transparent", border: "none", color: THEME.text, cursor: "pointer", width: "100%", textAlign: "left" }}
              className="text-sm px-2 py-1.5 rounded-lg hover:opacity-80"
            >
              ＋ 新しいプロジェクト
            </button>
            <button
              type="button"
              onClick={() => onDuplicateProject(activeProjectId)}
              style={{ background: "transparent", border: "none", color: THEME.text, cursor: "pointer", width: "100%", textAlign: "left" }}
              className="text-sm px-2 py-1.5 rounded-lg hover:opacity-80"
            >
              プロジェクトを複製
            </button>
            <button
              type="button"
              onClick={() => onStartRename(activeProjectId)}
              style={{ background: "transparent", border: "none", color: THEME.text, cursor: "pointer", width: "100%", textAlign: "left" }}
              className="text-sm px-2 py-1.5 rounded-lg hover:opacity-80"
            >
              名前を変更
            </button>

            <div style={{ height: 1, background: THEME.border, margin: "6px 2px" }} />

            <button
              type="button"
              onClick={onExportProject}
              title="現在のプロジェクトをJSONファイルとして書き出します（音源本体は含みません）"
              style={{ background: "transparent", border: "none", color: THEME.text, cursor: "pointer", width: "100%", textAlign: "left" }}
              className="text-sm px-2 py-1.5 rounded-lg hover:opacity-80"
            >
              プロジェクトを書き出す
            </button>
            <button
              type="button"
              onClick={onImportProject}
              title="JSONファイルからプロジェクトを新規追加として読み込みます"
              style={{ background: "transparent", border: "none", color: THEME.text, cursor: "pointer", width: "100%", textAlign: "left" }}
              className="text-sm px-2 py-1.5 rounded-lg hover:opacity-80"
            >
              プロジェクトを読み込む
            </button>

            <div style={{ height: 1, background: THEME.border, margin: "6px 2px" }} />

            <button
              type="button"
              onClick={() => onRequestDelete(activeProjectId)}
              disabled={projects.length <= 1}
              style={{
                background: "transparent",
                border: "none",
                color: projects.length <= 1 ? THEME.textDim : THEME.danger,
                cursor: projects.length <= 1 ? "not-allowed" : "pointer",
                width: "100%",
                textAlign: "left",
              }}
              className="text-sm px-2 py-1.5 rounded-lg hover:opacity-80"
            >
              プロジェクトを削除
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// Project削除の確認モーダル。出演者複数削除・構成削除と見た目を揃えつつ、
// 「この操作は元に戻せません」（11章：Project削除はUndo/Redo対象外のため文言でも明示する）を追加。
function ConfirmDeleteProjectModal({ projectName, onConfirm, onCancel }) {
  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 230,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: THEME.panelBg,
          border: `1px solid ${THEME.border}`,
          borderRadius: 14,
          padding: 20,
          minWidth: 280,
          maxWidth: "80vw",
        }}
      >
        <p style={{ color: THEME.text }} className="text-sm font-bold mb-1">
          「{projectName}」を削除しますか？
        </p>
        <p style={{ color: THEME.textDim }} className="text-xs mb-4">
          この操作は元に戻せません。
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            style={{ border: `1px solid ${THEME.border}`, color: THEME.text, background: "transparent" }}
            className="px-3 py-1.5 rounded-lg text-sm font-bold"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={{ background: THEME.danger, color: "#141318", border: `1px solid ${THEME.danger}` }}
            className="px-3 py-1.5 rounded-lg text-sm font-bold"
          >
            削除する
          </button>
        </div>
      </div>
    </div>
  );
}

// Project Backup v1：書き出し／読み込みの結果・エラーを案内する汎用モーダル。
// ConfirmDeleteProjectModalと同じ見た目・同じ「背景クリックで閉じる」挙動を踏襲しつつ、
// ボタンは「閉じる」1つだけのシンプルな構成にする（新しい通知UI基盤は追加しない）。
function ProjectBackupMessageModal({ tone, text, onClose }) {
  const isError = tone === "error";
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 230,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: THEME.panelBg,
          border: `1px solid ${isError ? THEME.danger : THEME.border}`,
          borderRadius: 14,
          padding: 20,
          minWidth: 280,
          maxWidth: "80vw",
        }}
      >
        <p style={{ color: isError ? THEME.danger : THEME.text }} className="text-sm font-bold mb-1">
          {isError ? "プロジェクトの読み込み・書き出しに失敗しました" : "プロジェクト"}
        </p>
        <p style={{ color: THEME.textDim }} className="text-xs mb-4">
          {text}
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            style={{ border: `1px solid ${THEME.border}`, color: THEME.text, background: "transparent" }}
            className="px-3 py-1.5 rounded-lg text-sm font-bold"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

// 各設定パネル内の「説明を見る」トグル（PART E・新規）。ヘッダーの「？ 操作方法」（アプリ全体の
// 操作方法）とは役割を分け、こちらは「その設定固有の意味」だけを扱う小さなボタン（28章）。
// 押すたびに開閉するだけのシンプルな見た目に留め、常時大きく表示しない（25章）。
function InfoToggle({ open, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{ color: THEME.textDim, background: "transparent", border: "none", padding: 0 }}
      className="text-[10px] underline decoration-dotted"
    >
      {open ? "説明を閉じる" : "？ 説明を見る"}
    </button>
  );
}

// 自動保存の実用化・PART E：保存中／保存済み／保存に失敗を示す、非常に小さな読み取り専用表示。
// クリック等の操作は持たない（新しい大きなボタンは追加しない方針）。workspace自体には
// 一切触れない、純粋なUI表示コンポーネント（Undo/Redo・work・IndexedDBのいずれにも無関係）。
function SaveStatusIndicator({ status }) {
  const label = status === "saving" ? "保存中…" : status === "error" ? "保存に失敗" : "保存済み";
  const color = status === "error" ? THEME.danger : THEME.textDim;
  const title =
    status === "saving"
      ? "編集内容をこのブラウザへ自動保存しています"
      : status === "error"
      ? "自動保存に失敗しました（ブラウザのストレージ容量などをご確認ください）"
      : "編集内容はこのブラウザへ自動保存されています";
  return (
    <span
      title={title}
      className="hidden sm:inline-flex items-center gap-1 text-xs"
      style={{ color, opacity: status === "error" ? 1 : 0.75 }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: color,
          opacity: status === "saving" ? 0.6 : 1,
        }}
      />
      {label}
    </span>
  );
}

function ViewToggleButton({ active, onClick, label }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? THEME.accent : THEME.panelBg2,
        color: active ? "#141318" : THEME.text,
        border: `1px solid ${active ? THEME.accent : THEME.border}`,
      }}
      className="px-3 py-1.5 rounded-lg text-sm font-bold"
    >
      {label}
    </button>
  );
}

// Undo/Redoのショートカット表記（Mac/Windowsで表示を出し分ける）
const IS_MAC_PLATFORM =
  typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent || navigator.platform || "");
const UNDO_SHORTCUT_LABEL = IS_MAC_PLATFORM ? "Command+Z" : "Ctrl+Z";
const REDO_SHORTCUT_LABEL = IS_MAC_PLATFORM ? "Command+Shift+Z" : "Ctrl+Shift+Z / Ctrl+Y";

// 元に戻す／やり直すボタン。矢印アイコン（Unicode）＋日本語ツールチップ付き。
function UndoRedoButton({ direction, onClick, disabled, title }) {
  const icon = direction === "undo" ? "↶" : "↷";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      style={{
        background: THEME.panelBg2,
        color: disabled ? THEME.textDim : THEME.text,
        border: `1px solid ${THEME.border}`,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
      className="w-8 h-8 rounded-lg text-base font-bold flex items-center justify-center"
    >
      {icon}
    </button>
  );
}

// 拡大縮小・表示位置のためのツールバー。
// 出演者データやステージ設定には一切触れず、viewState（表示専用の状態）だけを操作する。
function ZoomToolbar({ zoom, onZoomIn, onZoomOut, onReset100, onFitAll, onFitStage, onFitSelected, selectedDisabled }) {
  const zoomPercent = Math.round(zoom * 100);
  const smallBtn = {
    background: THEME.panelBg2,
    border: `1px solid ${THEME.border}`,
    color: THEME.text,
  };
  const smallBtnDisabled = {
    background: THEME.panelBg,
    border: `1px solid ${THEME.borderSoft}`,
    color: THEME.textDim,
  };
  return (
    <div className="flex items-center gap-2 mb-2 flex-wrap text-xs shrink-0">
      <div className="flex items-center gap-1">
        <button
          onClick={onZoomOut}
          disabled={zoomPercent <= ZOOM_MIN * 100}
          style={zoomPercent <= ZOOM_MIN * 100 ? smallBtnDisabled : smallBtn}
          className="w-7 h-7 rounded-lg font-bold"
        >
          −
        </button>
        <span style={{ color: THEME.text, width: 48 }} className="text-center font-bold text-sm">
          {zoomPercent}%
        </span>
        <button
          onClick={onZoomIn}
          disabled={zoomPercent >= ZOOM_MAX * 100}
          style={zoomPercent >= ZOOM_MAX * 100 ? smallBtnDisabled : smallBtn}
          className="w-7 h-7 rounded-lg font-bold"
        >
          ＋
        </button>
      </div>
      <button onClick={onReset100} style={smallBtn} className="px-2 py-1 rounded-lg font-bold">
        100%に戻す
      </button>
      <button onClick={onFitAll} style={smallBtn} className="px-2 py-1 rounded-lg font-bold">
        全体を表示
      </button>
      <button onClick={onFitStage} style={smallBtn} className="px-2 py-1 rounded-lg font-bold">
        ステージ本体に合わせる
      </button>
      <button
        onClick={onFitSelected}
        disabled={selectedDisabled}
        style={selectedDisabled ? smallBtnDisabled : smallBtn}
        className="px-2 py-1 rounded-lg font-bold"
      >
        選択中の出演者へフォーカス
      </button>
    </div>
  );
}

function NumberField({ label, value, min, max, step, onButtonChange, onInputChange, onInputFocus, onInputBlur, onInputKeyDown, suffix, disabled }) {
  // disabled はデフォルトfalse（未指定）。既存の呼び出し元（ステージ幅・奥行など）は
  // このprop自体を渡していないため、従来通り常に操作可能なまま挙動は変わらない。
  // BPMフィールドなど「再生中は編集不可にしたい」場合だけ disabled を渡す。
  const disabledStyle = { background: THEME.panelBg, border: `1px solid ${THEME.borderSoft}`, color: THEME.textDim };
  const enabledBtnStyle = { background: THEME.panelBg2, border: `1px solid ${THEME.border}`, color: THEME.text };
  return (
    <div>
      <div className="flex items-center justify-between">
        <label style={{ color: THEME.textDim }} className="text-xs">{label}</label>
        {suffix && <span style={{ color: THEME.textDim }} className="text-xs">{suffix}</span>}
      </div>
      <div className="flex items-center gap-2 mt-1">
        <button
          onClick={() => onButtonChange(value - step)}
          disabled={disabled}
          style={disabled ? disabledStyle : enabledBtnStyle}
          className="w-8 h-8 rounded-lg font-bold"
        >
          −
        </button>
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onFocus={onInputFocus}
          onChange={(e) => onInputChange(Number(e.target.value) || min)}
          onBlur={onInputBlur}
          onKeyDown={onInputKeyDown}
          style={disabled ? disabledStyle : inputStyle}
          className="w-full text-center rounded-lg py-1.5 text-sm font-bold"
        />
        <button
          onClick={() => onButtonChange(value + step)}
          disabled={disabled}
          style={disabled ? disabledStyle : enabledBtnStyle}
          className="w-8 h-8 rounded-lg font-bold"
        >
          ＋
        </button>
      </div>
    </div>
  );
}

// 入力操作の改善 v2：draft文字列を使った数値入力の「ロジック」を1つのカスタムフックへ共通化する。
// BPM・キープ・移動時間・楽曲セクション・音楽位置と対象が増えても、専用の見た目違いコンポーネントを
// 何個も作らずに済むよう、フックには状態管理（draft文字列の保持・確定処理）だけを持たせ、
// 実際のJSX（レイアウト）は呼び出し側（DraftNumberField・KeepCountsField・移動時間入力）に委ねる
// （PART B 11章：「ほぼ同じコンポーネントを3つ作らない」の対応方針）。
//   ・focus時：現在値を文字列化してdraftへコピーし、呼び出し側でe.target.select()を呼べば
//     入力欄のテキストが全選択される（6〜8章：「1」の状態で「2」と打鍵しても「12」にならない）。
//   ・入力中：draft文字列をそのまま保持するだけで、Numberへの変換・clamp・work反映は一切行わない
//     （2〜3章・12章）。空文字・"-"・"127."のような未確定の途中状態も自由に許可する（5章・9章）。
//   ・blur / Enter確定時にだけdraftをNumberへ変換し、有効な数値ならclampしてonCommitへ渡す（14章）。
//     空文字や無効な入力のまま確定した場合は、workを変更せずdraftを消して元の値の表示へ戻す
//     （5章・19章：勝手に0や既定値へ変換しない）。
function useDraftNumberInput({ value, min, max, allowDecimal = false, onCommit }) {
  const [draft, setDraft] = useState(null); // null = 非編集中（work上のvalueをそのまま表示）
  const displayValue = draft !== null ? draft : String(value);

  const handleFocus = useCallback(
    (e) => {
      setDraft(String(value));
      if (e && e.target && typeof e.target.select === "function") e.target.select();
    },
    [value]
  );
  const handleChange = useCallback((e) => setDraft(e.target.value), []);
  const handleBlur = useCallback(
    (e) => {
      const trimmed = String(e.target.value).trim();
      if (trimmed === "" || trimmed === "-" || trimmed === "." || trimmed === "-.") {
        setDraft(null);
        return;
      }
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) {
        setDraft(null);
        return;
      }
      const rounded = allowDecimal ? parsed : Math.round(parsed);
      const clamped = clamp(rounded, min, max);
      onCommit(clamped);
      setDraft(null);
    },
    [min, max, allowDecimal, onCommit]
  );
  const handleKeyDown = useCallback((e) => {
    if (e.key === "Enter") e.currentTarget.blur();
  }, []);

  return { displayValue, handleFocus, handleChange, handleBlur, handleKeyDown };
}

// 汎用の数値入力コンポーネント（PART A・PART B共通）。楽曲セクション（startSec/countStartSec/
// section BPM）・音楽位置（eighthNumber/countOffset）・project BPMで使用する。見た目は既存の
// NumberField（ステージ幅等で使用中。今回は変更しない＝26章）にほぼ揃えつつ、中身は
// useDraftNumberInputへ委ねる。onButtonChangeを渡した場合だけ－／＋ボタンを表示する
// （10章：既存の＋／－操作は維持しつつ、元々ボタンの無い楽曲セクションのstartSec等には追加しない）。
function DraftNumberField({ label, value, min, max, step, allowDecimal = false, onCommit, onButtonChange, suffix, disabled, inputClassName }) {
  const { displayValue, handleFocus, handleChange, handleBlur, handleKeyDown } = useDraftNumberInput({ value, min, max, allowDecimal, onCommit });
  const disabledStyle = { background: THEME.panelBg, border: `1px solid ${THEME.borderSoft}`, color: THEME.textDim };
  const enabledBtnStyle = { background: THEME.panelBg2, border: `1px solid ${THEME.border}`, color: THEME.text };

  return (
    <div>
      {(label || suffix) && (
        <div className="flex items-center justify-between">
          {label && <label style={{ color: THEME.textDim }} className="text-xs">{label}</label>}
          {suffix && <span style={{ color: THEME.textDim }} className="text-xs">{suffix}</span>}
        </div>
      )}
      <div className={`flex items-center gap-2 ${label || suffix ? "mt-1" : ""}`}>
        {onButtonChange && (
          <button
            type="button"
            onClick={() => onButtonChange(value - step)}
            disabled={disabled}
            style={disabled ? disabledStyle : enabledBtnStyle}
            className="w-8 h-8 rounded-lg font-bold shrink-0"
          >
            −
          </button>
        )}
        <input
          type="text"
          inputMode={allowDecimal ? "decimal" : "numeric"}
          value={displayValue}
          disabled={disabled}
          onFocus={handleFocus}
          onChange={handleChange}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          style={disabled ? disabledStyle : inputStyle}
          className={inputClassName || "w-full text-center rounded-lg py-1.5 text-sm font-bold"}
        />
        {onButtonChange && (
          <button
            type="button"
            onClick={() => onButtonChange(value + step)}
            disabled={disabled}
            style={disabled ? disabledStyle : enabledBtnStyle}
            className="w-8 h-8 rounded-lg font-bold shrink-0"
          >
            ＋
          </button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Music Timing v1.5：時刻（分:秒 / 秒）専用のdraft入力フック・コンポーネント
// ------------------------------------------------------------------
// useDraftNumberInputと全く同じ「focus中はdraft文字列を自由に編集し、blur/Enterでのみ確定する」
// という思想を踏襲するが、数値のclamp/roundではなくparseTimeInput()での解析を使う点、
// 表示にformatTimePrecise()（分:秒.小数第1位）を使う点が異なるため、無理に
// useDraftNumberInputを共用せず、同じ設計思想を持つ専用フックとして別に用意する（5章）。
// 不正な入力のままblur/Enterした場合は、work（Music Sectionの実データ）を一切変更せず、
// draftを消して元の値の表示へ戻す（5章：勝手に0秒などへ丸めない）。
function useDraftTimeInput({ value, onCommit }) {
  const [draft, setDraft] = useState(null); // null = 非編集中（value自体をformatTimePrecise()して表示）
  const displayValue = draft !== null ? draft : formatTimePrecise(value);

  const handleFocus = useCallback(
    (e) => {
      setDraft(formatTimePrecise(value));
      if (e && e.target && typeof e.target.select === "function") e.target.select();
    },
    [value]
  );
  const handleChange = useCallback((e) => setDraft(e.target.value), []);
  const handleBlur = useCallback(
    (e) => {
      const parsed = parseTimeInput(e.target.value);
      if (parsed == null) {
        setDraft(null); // 不正入力：workは変更せず元の値の表示へ戻す
        return;
      }
      onCommit(parsed); // 4章：Math.round()等で丸めず、parseTimeInputの結果をそのままcommitする
      setDraft(null);
    },
    [onCommit]
  );
  const handleKeyDown = useCallback((e) => {
    if (e.key === "Enter") e.currentTarget.blur();
  }, []);

  return { displayValue, handleFocus, handleChange, handleBlur, handleKeyDown };
}

// Music Sectionの「開始」「カウント開始」専用の入力コンポーネント（6章）。「94」のような秒数、
// 「1:34」「1:34.5」のような分:秒のどちらでも入力でき、確定後は常にformatTimePrecise()による
// 分:秒表示（例：1:34.5）に統一する。補助情報として小さく秒数（例：94.5秒）も併記する
// （メイン表示はあくまで分:秒。既存Music Barの「1:34 / 4:54」という見た目・理解のされ方に揃える）。
function TimeInputField({ label, value, onCommit, disabled }) {
  const { displayValue, handleFocus, handleChange, handleBlur, handleKeyDown } = useDraftTimeInput({ value, onCommit });
  return (
    <div>
      {label && <span style={{ color: THEME.textDim, fontSize: 9 }}>{label}</span>}
      <input
        type="text"
        inputMode="text"
        value={displayValue}
        disabled={disabled}
        onFocus={handleFocus}
        onChange={handleChange}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        placeholder="1:34.5"
        style={disabled ? { background: THEME.panelBg, border: `1px solid ${THEME.borderSoft}`, color: THEME.textDim } : inputStyle}
        className="w-full rounded px-1 py-1 text-xs text-center"
      />
      <div style={{ color: THEME.textDim, fontSize: 9 }} className="text-center mt-0.5">
        {Number.isFinite(value) ? `${value}秒` : ""}
      </div>
    </div>
  );
}

// キープ（右パネル）・移動時間（構成バー）専用の数値編集UI。NumberField / DraftNumberField
// （ラベル＋補助表示を1行目、－／input／＋を2行目に置く構造で、inputがw-full＝残りスペースに
// 応じて伸縮する）とは別に用意してある。理由：エイト換算の補助表示（0エイト〜2エイトなど）の
// 文字幅が変わると、周辺のレイアウトの揺れにつられて＋ボタンの位置までわずかに動いてしまうため。
// このコンポーネントでは、
//   1行目：CSS Gridで「－ボタン（32px固定）／count表示（1fr）／＋ボタン（32px固定）」に分離し、
//          左右のボタン列幅が常に固定されるようにする（中央のcount表示がどんな文字数でも
//          ＋／－ボタンは絶対に動かない＝23章のレイアウトシフト対策を維持）。
//   2行目：エイト換算表示は別のDOM行として完全に切り離し、1行目のレイアウトに一切影響しない
//          構造にする。
// count表示自体も、input側にfont-variant-numeric:tabular-nums＋固定width（3.5em）を持たせて、
// 桁数が変わってもガタつかないようにしている。
// 入力操作の改善v2：draft文字列の管理・確定処理はDraftNumberFieldと全く同じ
// useDraftNumberInputフックへ委ね、「キープ専用のほぼ同じコンポーネント」を別途作らない（11章）。
function KeepCountsField({ value, min, max, step, allowDecimal = false, onButtonChange, onCommit, eighthsLabel, disabled }) {
  const { displayValue, handleFocus, handleChange, handleBlur, handleKeyDown } = useDraftNumberInput({ value, min, max, allowDecimal, onCommit });
  const disabledStyle = { background: THEME.panelBg, border: `1px solid ${THEME.borderSoft}`, color: THEME.textDim };
  const enabledBtnStyle = { background: THEME.panelBg2, border: `1px solid ${THEME.border}`, color: THEME.text };
  return (
    <div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "32px 1fr 32px",
          alignItems: "center",
          columnGap: 8,
        }}
      >
        <button
          type="button"
          onClick={() => onButtonChange(value - step)}
          disabled={disabled}
          style={disabled ? disabledStyle : enabledBtnStyle}
          className="w-8 h-8 rounded-lg font-bold"
          aria-label="1カウント減らす"
          title="1カウント減らす"
        >
          −
        </button>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "center", gap: 4, minWidth: 0 }}>
          <input
            type="text"
            inputMode={allowDecimal ? "decimal" : "numeric"}
            value={displayValue}
            disabled={disabled}
            onFocus={handleFocus}
            onChange={handleChange}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            style={{ ...(disabled ? disabledStyle : inputStyle), width: "3.5em", textAlign: "center", fontVariantNumeric: "tabular-nums" }}
            className="rounded-lg py-1.5 text-sm font-bold"
          />
          <span style={{ color: THEME.textDim, flexShrink: 0 }} className="text-xs">
            count
          </span>
        </div>
        <button
          type="button"
          onClick={() => onButtonChange(value + step)}
          disabled={disabled}
          style={disabled ? disabledStyle : enabledBtnStyle}
          className="w-8 h-8 rounded-lg font-bold"
          aria-label="1カウント増やす"
          title="1カウント増やす"
        >
          ＋
        </button>
      </div>
      <div style={{ color: THEME.textDim, textAlign: "center" }} className="text-xs mt-1">
        {eighthsLabel}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Music Bar（音楽基盤 v2：Web Audio API方式）
// ------------------------------------------------------------------
// 音楽ファイルの読み込み・再生・一時停止・シークだけを行う、コンパクトな1行のプレイヤー。
// 構成間アニメーション（▶/▶▶・スクラバー・keepCounts/transitionCounts）とは完全に独立しており、
// ここでの操作がそれらを自動的に開始・停止させることは一切ない（31章）。
// File・AudioContext・AudioBuffer・AudioBufferSourceNodeの実体はApp側のruntime ref（work外）の
// ままで、このコンポーネント自身は表示とイベントの橋渡しのみを行い、何もwork（作品データ）へ
// 書き込まない。見た目は<audio>ベースだったv1から意図的にほぼ変えていない（38章）。
function MusicBar({
  musicMeta,
  musicStatus,
  musicCurrentTime,
  musicError,
  musicDiagnostics,
  projectBpm,
  musicTotalEighths,
  onFileChange,
  onPlayPause,
  onSeek,
  onSeekCommit, // Music Seek → Formation Reverse Mapping v1・4章：シーク確定（pointerup等）で呼ぶ
  onRemove,
  syncActive, // Music Sync Playback v1・30章：同期再生中は音楽側の手動▶/⏸・スクラバーをdisabledにする
  syncPaused, // Music Seek → Formation Reverse Mapping v1・1章：同期セッションが一時停止中か
  syncSeekPreview, // 逆算結果（found:falseなら対応する構成が無い旨を表示する＝29章）
  formationMarkers, // Music Timeline / Formation Markers v1：曲全体タイムライン上の構成マーカー（8・14章）
  sectionBoundaryMarkers, // 同v1：Music Sectionの境界（startSec基準）マーカー（9・10章）
  currentSlideIndex, // 同v1・4章：現在の構成を強調表示するため
  onMarkerClick, // 同v1・6章：マーカークリック時の構成切替（既存goToSlideをApp側で呼ぶ）
  markersInteractive, // 同v1・6・7章：アニメーション再生中・同期再生中はマーカー操作不可
}) {
  const fileInputRef = useRef(null);
  const hasFile = musicMeta.fileName !== "";
  const duration = musicMeta.durationSec;
  const hasDuration = duration != null && Number.isFinite(duration);
  const isPlaying = musicStatus === "playing";
  const canPlay = (musicStatus === "ready" || musicStatus === "playing" || musicStatus === "paused") && !syncActive;
  // Music Seek → Formation Reverse Mapping v1・1〜3章：音楽スクラバー自体は、通常の音楽再生
  // モード（canPlay）に加えて、「同期再生を一時停止している間」（syncActive && syncPaused）も
  // 操作可能にする（♫▶実行中/preroll再生中は従来通りdisabledのまま＝2章）。
  const syncSeekEnabled = !!(syncActive && syncPaused);
  const canSeek = hasDuration && (canPlay || syncSeekEnabled);
  const isBusy = musicStatus === "reading" || musicStatus === "decoding";
  // 診断の詳細（28章）は常時表示せず、このトグルでのみ開閉する。エラー時だけでなく、
  // decodeまでは成功しているかを確認したい場合にも使える（29章：decode成功と音声出力成功を分ける）。
  const [showDetail, setShowDetail] = useState(false);

  const statusLabel =
    musicStatus === "reading"
      ? "読み込み中…"
      : musicStatus === "decoding"
      ? "解析中…"
      : musicStatus === "error"
      ? null // エラーメッセージは下の⚠行で表示するためここでは出さない
      : null;

  return (
    <div className="flex items-center gap-2 mt-2 text-xs shrink-0 flex-wrap" style={{ color: THEME.textDim }}>
      <span style={{ flexShrink: 0, fontWeight: 700, color: THEME.text }}>音楽</span>

      {/* 実際のファイル選択inputは非表示にし、見た目を既存UIのボタンと揃える。 */}
      <input ref={fileInputRef} type="file" accept="audio/*" onChange={onFileChange} style={{ display: "none" }} />
      <button
        type="button"
        onClick={() => fileInputRef.current && fileInputRef.current.click()}
        style={{ background: THEME.panelBg2, border: `1px solid ${THEME.border}`, color: THEME.text, flexShrink: 0 }}
        className="px-2 py-1 rounded-lg font-bold"
      >
        ファイルを選択
      </button>

      {hasFile ? (
        <>
          <span
            style={{
              color: THEME.text,
              maxWidth: 140,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flexShrink: 1,
            }}
            title={musicMeta.fileName}
          >
            {musicMeta.fileName || "（無題）"}
          </span>

          {statusLabel && <span style={{ flexShrink: 0 }}>{statusLabel}</span>}

          <button
            type="button"
            onClick={onPlayPause}
            disabled={!canPlay}
            style={{
              background: THEME.panelBg2,
              border: `1px solid ${THEME.border}`,
              color: canPlay ? THEME.text : THEME.textDim,
              opacity: canPlay ? 1 : 0.5,
              flexShrink: 0,
            }}
            className="w-7 h-7 rounded-lg font-bold"
            aria-label={isPlaying ? "音楽を一時停止" : "音楽を再生"}
            title={syncActive ? "同期再生中は音楽を個別に操作できません" : isPlaying ? "一時停止" : "再生"}
          >
            {isPlaying ? "⏸" : "▶"}
          </button>

          <span style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
            {formatTime(musicCurrentTime)} / {formatTime(duration)}
          </span>

          {/* 音楽専用スクラバー：構成間アニメーション用スクラバー（min=0/max=1のprogress）とは
              完全に別物。こちらはmin=0/max=durationSec（秒）で、Web Audio APIの再生位置
              （musicOffsetSec + 経過時間）を直接動かす。
              Music Sync Playback v1・30章：同期再生中（実際に再生/preroll中）はユーザーが
              音楽だけseekして同期が崩れないよう、手動操作を無効化する。
              Music Seek → Formation Reverse Mapping v1・1〜4章：ただし「同期一時停止中」だけは
              例外的に有効化する（syncSeekEnabled）。onChangeは今まで通り毎回呼ばれ、音楽位置の
              表示・オフset更新だけを行う（既存handleMusicSeekのまま・22章：一時停止中は新しい
              SourceNodeを鳴らさない）。実際の構成位置の逆算（resolveTimelineAtMusicTime）は、
              ドラッグ中は行わず、onPointerUp/onMouseUp/onTouchEnd（確定）でonSeekCommitを
              呼んだときだけ行う（4章：毎フレームの複雑な逆算は今回不要）。 */}
          {/* Music Timeline / Formation Markers v1：既存のrange input自体（操作性・イベントの
              どれも一切変更しない＝19章）を、position:relativeのラッパーで包み、Section境界・
              構成マーカーをその上にposition:absoluteで重ねるだけの表示専用レイヤーにする。
              flex:1/minWidth/maxWidthをラッパー側へ移し、rangeはwidth:100%でラッパーいっぱいに
              広げることで、JS側で幅を計測しなくてもマーカーのleft（%）がrange本体と常に一致する。 */}
          <div style={{ position: "relative", flex: 1, minWidth: 100, maxWidth: 220 }}>
            <input
              type="range"
              min={0}
              max={hasDuration ? duration : 0}
              step={0.1}
              value={hasDuration ? Math.min(musicCurrentTime, duration) : 0}
              disabled={!canSeek}
              onChange={onSeek}
              onPointerUp={onSeekCommit}
              onMouseUp={onSeekCommit}
              onTouchEnd={onSeekCommit}
              title={
                syncSeekEnabled
                  ? "音楽の位置から対応する構成を探します（指を離す/クリックを離すと確定します）"
                  : syncActive
                  ? "同期再生中は音楽の位置を個別に操作できません"
                  : "音楽の再生位置（構成間アニメーション用スクラバーとは別物です）"
              }
              style={{ width: "100%", display: "block", accentColor: THEME.accent }}
            />
            {/* Music Section境界（9・10章）：startSec基準の小さな縦線。hover/titleでSection名のみ表示し、
                常時は目立たせない（THEME.textDimの細い線1本）。クリック操作は持たせない（境界編集は対象外＝23章）。 */}
            {hasDuration && sectionBoundaryMarkers && sectionBoundaryMarkers.length > 0 && (
              <div style={{ position: "absolute", left: 0, right: 0, top: -4, height: 4, pointerEvents: "none" }}>
                {sectionBoundaryMarkers.map((b) => (
                  <div
                    key={b.sectionId}
                    title={b.name}
                    style={{
                      position: "absolute",
                      left: `${b.ratio * 100}%`,
                      top: 0,
                      width: 1,
                      height: 4,
                      background: THEME.textDim,
                      pointerEvents: "auto",
                    }}
                  />
                ))}
              </div>
            )}
            {/* 構成マーカー（1〜7章）：各構成の音楽上の位置を小さな丸マーカーで表示する。
                手動Anchorは少し強い表示（塗り＋アクセント枠）、自動Anchorは通常表示（枠のみ）、
                現在構成はさらにサイズ・アクセント色で強調する（3・4章）。20〜50構成程度でも
                各マーカーは複雑なstateを一切持たない単純な<button>のみ（13章）。近接マーカーは
                index偶奇で上下にごく軽くずらすだけの軽量な工夫に留める（12章：高度な衝突回避はしない）。 */}
            {hasDuration && formationMarkers && formationMarkers.length > 0 && (
              <div style={{ position: "absolute", left: 0, right: 0, bottom: -7, height: 14, pointerEvents: "none" }}>
                {formationMarkers.map((m, i) => {
                  const isCurrent = m.slideIndex === currentSlideIndex;
                  const size = isCurrent ? 10 : 8;
                  const staggered = i % 2 === 1 ? 6 : 0;
                  return (
                    <button
                      key={m.slideId}
                      type="button"
                      onClick={() => markersInteractive && onMarkerClick && onMarkerClick(m.slideIndex)}
                      disabled={!markersInteractive}
                      title={m.titleText}
                      aria-label={`構成${m.slideIndex + 1}へ移動`}
                      style={{
                        position: "absolute",
                        left: `${m.ratio * 100}%`,
                        bottom: staggered,
                        transform: "translateX(-50%)",
                        width: size,
                        height: size,
                        borderRadius: 999,
                        padding: 0,
                        background: isCurrent ? THEME.accent : m.isManualAnchor ? THEME.text : "transparent",
                        border: `1.5px solid ${isCurrent || m.isManualAnchor ? THEME.accent : THEME.textDim}`,
                        opacity: m.outOfRange ? 0.45 : 1,
                        cursor: markersInteractive ? "pointer" : "default",
                        pointerEvents: "auto",
                        lineHeight: 0,
                      }}
                    />
                  );
                })}
              </div>
            )}
          </div>
          {/* Music Seek → Formation Reverse Mapping v1・29章：逆算した結果、対応する構成が
              見つからなかった場合（部分制作でまだ作っていない空白）の小さな警告表示。
              前後の構成へは自動吸着しない（30章）ため、その旨をユーザーに明示する。 */}
          {syncSeekEnabled && syncSeekPreview && syncSeekPreview.found === false && (
            <span style={{ color: THEME.danger, flexShrink: 0, fontSize: 10 }}>
              ⚠ この音楽位置に対応する構成はありません
            </span>
          )}

          {/* project BPMの参照表示のみ（編集UIは右パネルの「BPM」セクションを維持し、ここには
              重複した編集UIを新設しない＝30章）。durationSecが取得できていれば、将来の
              「総エイト数」表示への布石として簡単な目安も添える（16章：優先度は低いが軽量なので表示）。 */}
          <span style={{ flexShrink: 0 }}>
            BPM {projectBpm}
            {hasDuration && musicTotalEighths != null && ` ・ 約${(Math.round(musicTotalEighths * 10) / 10).toFixed(1)}エイト`}
          </span>

          <button
            type="button"
            onClick={onRemove}
            style={{ border: `1px solid ${THEME.border}`, color: THEME.textDim, background: "transparent", flexShrink: 0 }}
            className="px-2 py-1 rounded-lg text-[11px]"
            title="読み込んだ音楽を外します"
          >
            音楽を外す
          </button>

          {musicDiagnostics && (
            <button
              type="button"
              onClick={() => setShowDetail((v) => !v)}
              style={{ border: `1px solid ${THEME.border}`, color: THEME.textDim, background: "transparent", flexShrink: 0 }}
              className="px-1.5 py-0.5 rounded text-[10px] font-bold"
            >
              {showDetail ? "詳細を隠す" : "詳細"}
            </button>
          )}
        </>
      ) : (
        <span style={{ flexShrink: 0 }}>音楽ファイルが読み込まれていません</span>
      )}

      {musicError && (
        <span style={{ color: THEME.danger, flexShrink: 0 }}>⚠ {musicError}</span>
      )}

      {/* 診断チェックリスト（28・29章）：File選択〜SourceNode.start()までの各段階を個別に表示し、
          「decodeまでは成功したが実際の音声出力だけができない」ようなケースを、ユーザー自身が
          開発者ツール無しでも切り分けられるようにする。普段は非表示、上の「詳細」ボタンでのみ開閉する。 */}
      {musicDiagnostics && showDetail && (
        <div
          style={{
            width: "100%",
            color: THEME.textDim,
            fontSize: 10,
            wordBreak: "break-all",
            background: THEME.panelBg2,
            border: `1px solid ${THEME.borderSoft}`,
            borderRadius: 6,
            padding: "6px 8px",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <div>
            {musicDiagnostics.fileSelected ? "✓" : "・"} File selected
            {musicDiagnostics.fileSelected && `: ${musicDiagnostics.fileSelected.name}（${musicDiagnostics.fileSelected.type || "type不明"}, ${musicDiagnostics.fileSelected.size.toLocaleString()} bytes）`}
          </div>
          <div>
            {musicDiagnostics.arrayBufferLoaded ? "✓" : musicDiagnostics.lastError && musicDiagnostics.lastError.stage === "arrayBuffer" ? "✗" : "・"} ArrayBuffer loaded
            {musicDiagnostics.arrayBufferLoaded && `（${musicDiagnostics.arrayBufferLoaded.byteLength.toLocaleString()} bytes）`}
          </div>
          <div>
            {musicDiagnostics.decoded && musicDiagnostics.decoded.ok
              ? "✓"
              : musicDiagnostics.decoded && musicDiagnostics.decoded.ok === false
              ? "✗"
              : "・"}{" "}
            AudioBuffer decoded
          </div>
          <div>
            {musicDiagnostics.duration != null ? "✓" : "・"} duration
            {musicDiagnostics.duration != null && `: ${musicDiagnostics.duration.toFixed(2)} sec`}
            {musicDiagnostics.sampleRate != null && ` / sampleRate: ${musicDiagnostics.sampleRate}`}
            {musicDiagnostics.numberOfChannels != null && ` / channels: ${musicDiagnostics.numberOfChannels}`}
          </div>
          <div>{musicDiagnostics.contextState ? `✓ AudioContext: ${musicDiagnostics.contextState}` : "・ AudioContext: -"}</div>
          <div>
            {musicDiagnostics.sourceStarted
              ? `✓ SourceNode started (offset ${musicDiagnostics.sourceStarted.offset.toFixed(2)}s)`
              : musicDiagnostics.lastError && musicDiagnostics.lastError.stage === "start"
              ? "✗ SourceNode start failed"
              : "・ SourceNode: -"}
          </div>
          {musicDiagnostics.lastError && (
            <div style={{ color: THEME.danger }}>
              ✗ {musicDiagnostics.lastError.stage}: {musicDiagnostics.lastError.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// 構成バー（複数スライド機能の土台）
// ------------------------------------------------------------------
// PowerPointのスライド一覧をかなりコンパクトにしたイメージのUI。
// タイムライン・アニメーション・自動再生・サムネイル生成は今回は一切扱わない。
// 高さは80〜100px程度に収まるよう固定高（88px）にしている。
const compositionNavBtnStyle = (disabled) => ({
  background: disabled ? THEME.panelBg : THEME.panelBg2,
  border: `1px solid ${disabled ? THEME.borderSoft : THEME.border}`,
  color: disabled ? THEME.textDim : THEME.text,
  opacity: disabled ? 0.5 : 1,
  cursor: disabled ? "not-allowed" : "pointer",
});

const compositionActionBtnStyle = {
  background: THEME.panelBg2,
  border: `1px solid ${THEME.border}`,
  color: THEME.text,
  whiteSpace: "nowrap",
};

// ------------------------------------------------------------------
// UI Stability & Bottom Navigation v1・PART B：近隣構成カードの算出
// ------------------------------------------------------------------
// 「全構成横スクロール」から「現在構成＋近隣構成だけの固定ウィンドウ」へ変更するための
// pure関数。DOM・React stateには一切依存せず、(currentIndex, totalCount, windowSize)の
// 3つの数値だけから「表示すべきslides配列のインデックス一覧」を返す。
//   ・totalCount <= windowSizeの場合は全件をそのまま返す（横スクロール自体が不要なため）。
//   ・それ以外は、currentIndexを中心にwindowSize枚を切り出す。ただし配列の先頭・末尾に
//     近い場合はwindowSize枚を確保できるよう開始位置をclampする（＝1件目や最終件目でも
//     必ずwindowSize枚のカードが表示され続け、バーの見た目の枚数が変化しない）。
// 戻り値は常に昇順の連番インデックス配列（例：[21,22,23,24,25]）。
// Bottom Control Bar v2・2章：5枚→3枚（前の構成／現在構成／次の構成が基本）。
// 遠い構成への移動は近隣カードの責務ではなく、既存の「構成一覧」に一本化する（4章）。
const NEARBY_SLIDE_WINDOW_SIZE = 3;

function computeNearbySlideIndices(currentIndex, totalCount, windowSize) {
  if (!(totalCount > 0)) return [];
  const size = Math.min(windowSize, totalCount);
  const half = Math.floor(size / 2);
  const maxStart = totalCount - size;
  const start = clamp(currentIndex - half, 0, maxStart);
  const indices = [];
  for (let i = start; i < start + size; i += 1) indices.push(i);
  return indices;
}

// Bottom Control Bar v2.1・4章：近隣カード3枚ぶんの幅は「余ったスペースがあれば表示」
// ではなく、最初から固定で予約する。SlideCard自体の実幅（下のSlideCard関数の
// style.width＝50pxと同じ値をここで一元管理し、二重管理を避ける）と、並びのgap
// （6px＝Tailwindのgap-1.5相当）から算出する。
const SLIDE_CARD_WIDTH = 50;
const SLIDE_CARD_GAP = 6;
const NEARBY_CARDS_RESERVED_WIDTH =
  NEARBY_SLIDE_WINDOW_SIZE * SLIDE_CARD_WIDTH + (NEARBY_SLIDE_WINDOW_SIZE - 1) * SLIDE_CARD_GAP;

// Bottom Control Bar v2.1・2・9章：各ゾーンの最小必要幅の見積もり。実測ピクセル値の
// 当てずっぽうではなく、各ボタンに使っているTailwindクラス（w-8 h-8=32px等）と
// gap値から積み上げて算出する。v2で問題になった「viewport幅のmedia query」による
// 縮退判定は、サイドバー開閉などでCompositionBar自体の実際の幅とズレることがあり
// 廃止した。代わりにこの見積り幅を、ResizeObserverで測ったCompositionBar自身の
// 実幅と比較して縮退レベル（0・1・2）を決める。
const CB_NAV_BLOCK_MIN_WIDTH = 32 + 6 + 64 + 6 + 32; // ◀(32) + 現在位置(min64) + ▶(32) + gap*2(6)
const CB_RETURN_TO_EDIT_FULL_WIDTH = 96; // 「■ 編集に戻る」表示（常時予約スロット・13章）
const CB_RETURN_TO_EDIT_COMPACT_WIDTH = 40; // レベル1以降：「■」アイコンのみに短縮
const CB_PLAYBACK_BLOCK_MIN_WIDTH = 32 * 4 + 4 * 3 + CB_RETURN_TO_EDIT_FULL_WIDTH; // ▶▶▶♫▶⏸ + 編集に戻る
const CB_PLAYBACK_BLOCK_MIN_WIDTH_COMPACT = 32 * 4 + 4 * 3 + CB_RETURN_TO_EDIT_COMPACT_WIDTH;
// Bottom Control Bar v2.2・Final Polish：3・4・6章。LEFTゾーン内のgap（nav-group⇔
// playback-group間）を8px/4px→6px/3pxへわずかに詰めた。ボタン自体のサイズ・機能は
// 一切変更していない（不要な余白のみ回収）。
const CB_LEFT_ZONE_GAP_FULL = 6;
const CB_LEFT_ZONE_GAP_COMPACT = 3;
const CB_LEFT_ZONE_MIN_WIDTH = CB_NAV_BLOCK_MIN_WIDTH + CB_LEFT_ZONE_GAP_FULL + CB_PLAYBACK_BLOCK_MIN_WIDTH;
const CB_LEFT_ZONE_MIN_WIDTH_COMPACT =
  CB_NAV_BLOCK_MIN_WIDTH + CB_LEFT_ZONE_GAP_COMPACT + CB_PLAYBACK_BLOCK_MIN_WIDTH_COMPACT;
const CB_TRANSITION_BLOCK_MIN_WIDTH = 108;
// v2.2：CENTERゾーン内（移動時間⇔近隣カード間）のgapを10px→8pxへ詰めた。
const CB_CENTER_ZONE_GAP = 8;
const CB_CENTER_ZONE_MIN_WIDTH =
  CB_TRANSITION_BLOCK_MIN_WIDTH + CB_CENTER_ZONE_GAP + NEARBY_CARDS_RESERVED_WIDTH;
// レベル2（近隣カードを現在の1枚のみへ縮退）まで縮めた場合のCENTERゾーン最小幅
const CB_CENTER_ZONE_MIN_WIDTH_COMPACT =
  CB_TRANSITION_BLOCK_MIN_WIDTH + CB_CENTER_ZONE_GAP + SLIDE_CARD_WIDTH;
// v2.2：RIGHT（構成管理）ゾーン内のボタン間gapを6px（gap-1.5）→4px（gap-1）へ詰めた。
// ボタン自体（w-8 h-8=32px固定）のサイズは変更していない。
const CB_MANAGEMENT_ZONE_GAP = 4;
const CB_MANAGEMENT_ZONE_MIN_WIDTH = 32 * 4 + CB_MANAGEMENT_ZONE_GAP * 3; // ＋ 🗑 ▦ ⭳ + gap*3
// v2.2：LEFT/CENTER/RIGHTゾーン間・区切り線まわりのgap（バー自体のgap）を12px→8pxへ詰めた。
const CB_ZONE_GAP = 8;
const CB_DIVIDER_WIDTH = 1;
// v2.2：CompositionBar全体の左右paddingを"8px 10px"→"8px 8px"へ詰めた（左右合計20→16）。
const CB_BAR_PADDING_X = 16;
// v2.2・Final Polish：v2.1では「各ゾーンの積み上げ見積り幅の合計」をそのまま閾値としており、
// 安全マージンが無かった。実際のブラウザ描画では、border-box計算・フォントの端数丸め・
// flexboxのgap丸めなど、Tailwindクラスからの単純な積み上げ計算だけでは吸収しきれない
// 数px単位の誤差が生じうる。これが「構成3件以上・Music Sync Playback中に右端が数px〜
// 十数pxはみ出す」不具合の直接の原因（RIGHTゾーンがshrink:0のため、閾値ぎりぎりの実幅では
// 計算上ちょうど収まるはずが実際には数px不足し、はみ出す側＝一番右のRIGHTゾーンに現れていた）。
// v2.2ではgap/padding自体を実際に詰めて必要幅を下げると同時に、この安全マージンを
// 新たに設けることで「境界ぎりぎりでフル表示のまま数pxはみ出す」状態を作らないようにした。
const CB_SAFETY_MARGIN = 12;
// レベル0（フル表示・3カード・「編集に戻る」フル表示）を維持できる最小のCompositionBar実幅。
// これ以上の実測幅があれば、常に3枚の近隣カードが表示される（1章：最重要要件）。
const COMPOSITION_BAR_COMPACT_THRESHOLD_1 =
  CB_LEFT_ZONE_MIN_WIDTH +
  CB_ZONE_GAP + CB_DIVIDER_WIDTH + CB_ZONE_GAP +
  CB_CENTER_ZONE_MIN_WIDTH +
  CB_ZONE_GAP + CB_DIVIDER_WIDTH + CB_ZONE_GAP +
  CB_MANAGEMENT_ZONE_MIN_WIDTH +
  CB_BAR_PADDING_X +
  CB_SAFETY_MARGIN;
// レベル1（gap圧縮＋「編集に戻る」短縮、近隣カードは3枚のまま）を維持できる最小幅。
// これを下回った場合だけ、最終手段として近隣カードを1枚へ縮退する（レベル2）。
const COMPOSITION_BAR_COMPACT_THRESHOLD_2 =
  CB_LEFT_ZONE_MIN_WIDTH_COMPACT +
  CB_ZONE_GAP + CB_DIVIDER_WIDTH + CB_ZONE_GAP +
  CB_CENTER_ZONE_MIN_WIDTH_COMPACT +
  CB_ZONE_GAP + CB_DIVIDER_WIDTH + CB_ZONE_GAP +
  CB_MANAGEMENT_ZONE_MIN_WIDTH +
  CB_BAR_PADDING_X +
  CB_SAFETY_MARGIN;

// Bottom Control Bar v2.1・9章：CompositionBar自身の実測幅から縮退レベル（0/1/2）を
// 決めるロジック本体。DOM/React非依存のpure関数として切り出すことで、
// ResizeObserverのコールバック内での二重実装を避け、単体テストも可能にする。
function decideCompositionBarCompactLevel(width) {
  if (width >= COMPOSITION_BAR_COMPACT_THRESHOLD_1) return 0;
  if (width >= COMPOSITION_BAR_COMPACT_THRESHOLD_2) return 1;
  return 2;
}

function CompositionBar({
  slides,
  currentIndex,
  onSelect,
  onPrev,
  onNext,
  onAddNew,
  onDeleteSlide,
  canDeleteSlide,
  onReorder,
  onShowList,
  playbackState, // "idle" | "playing" | "paused"
  dataEditLocked, // 再生中または一時停止中（＝表示が実データではなく遷移プレビュー状態）
  canPlay,
  onPlay,
  onPause,
  onReturnToEdit, // 一時停止中だけ表示する「編集に戻る」ボタンのハンドラ（PART B・新規）
  canPlayContinuous,
  onPlayContinuous,
  statusLabel, // App側で組み立て済みの再生状況ラベル。{ main, isPaused } または idle時はnull（PART A・2行化に伴い形が変わった）
  hasNextSlideForTransition,
  transitionCounts,
  onStepTransitionCounts,
  onCommitTransitionCounts, // 移動時間の絶対値コミット（PART B・DraftNumberField化）。旧: onSetTransitionCountsLive/onTransitionCountsFocus/Blur/KeyDown
  // Music Sync Playback v1：「現在の構成から、音楽と構成アニメーションを同期して再生」用の追加props。
  canStartSyncPlayback, // 開始条件（musicAnchorあり・AudioBufferあり・duration内）を満たしているか
  syncPlaybackBlockedReason, // 満たしていない場合の理由（小さいwarning表示・title用）。満たしていればnull
  syncPlaybackActive, // 同期セッションが開始済みか（一時停止中も含む）
  syncPlaybackPaused, // 同期セッションが一時停止中か
  syncPlaybackPreroll, // Music Timing v1.5：プリロール（イントロ）中か
  syncPrerollRemainingSec, // プリロール中：カウント開始までの残り秒数（nullなら非表示）
  // 再生中の音楽位置表示 v1・STEP6：「♫ 2曲目　12エイト目・5カウント目」等、App側で
  // 組み立て済みの文字列（またはnull＝非表示）。App側は同期再生中・通常アニメーション再生中の
  // 両方でこの値を計算しているが、左端主表示整理 v1により、実際に左端主表示（
  // primaryPlaybackStatusLabel）へ採用するのは同期再生中（syncPlaybackActive）だけにしている
  // （通常▶/▶▶では従来通りstatusLabel.mainを主表示にする）。このコンポーネント自体は
  // 音楽位置の計算ロジックを一切持たない。
  musicPlaybackPositionLabel,
  // 左端2行表示 v1：同期再生中だけ2行目として使う、構成側の進行状況（「1 キープ 3/8 count」
  // 「1 → 2　移動 2/4 count」等、ReactNode）。App側で計算済みの値をそのまま表示するだけで、
  // このコンポーネント自体はkeep/moveの計算ロジックを持たない。preroll中はnull（＝空欄。
  // ただし2行目の高さ自体は確保する）。
  syncAnimationStatusLabel,
  onStartSyncPlayback, // ♫▶ボタンのハンドラ（新規開始専用。一時停止中はここではなくonResumeSyncPlaybackを呼ぶ＝Sync Playback v1.6）
  onResumeSyncPlayback, // ♫▶ボタンのハンドラ（Sync Playback v1.6・6〜8章：同期一時停止中の再開専用）
  syncDriftSec, // 次slideのmusicAnchorとの理論位置とのズレ（20章・任意表示。nullなら非表示）
  // PNG Export v1・2章：構成一覧ボタン（▦）付近に配置する「PNG出力」ボタン用のprops。
  onExportPng, // クリック時のハンドラ（Export Center v1：App側でExport Centerモーダルを開くだけ。直接PNGは生成しない）
  pngExportDisabled, // 22章：再生中（isTransitionActive）はdisabledにする
}) {
  // 移動時間（count）入力用のdraft state。KeepCountsFieldと同じuseDraftNumberInputを
  // 使うことでBPM・キープ・移動時間の3箇所が同じ「フォーカスで全選択→自由に編集→
  // blur/Enterで確定」の挙動を共有する（PART B）。CompositionBarはコンパクトな横並び
  // 専用レイアウトのため、KeepCountsFieldコンポーネント自体は使わずフック単体を呼ぶ。
  // 値が無効（次の構成が無い）場合はhasNextSlideForTransition側でdisabled表示にするため
  // ここではvalueに現在値をそのまま渡しておく（disabled時はinput自体が操作不能）。
  const transitionCountsDraft = useDraftNumberInput({
    value: transitionCounts,
    min: MIN_TRANSITION_COUNTS,
    max: 9999,
    allowDecimal: false,
    onCommit: onCommitTransitionCounts,
  });
  // 「実際にrAFで進行中」の厳密な再生中フラグ。一時停止ボタンの有効化・ステータスラベルの
  // 「再生中」表示など、paused状態とはっきり区別したい箇所でのみ使う。
  const isPlaying = playbackState === "playing";
  const isPaused = playbackState === "paused";
  // Sync Playback v1.6・2〜8章：同期一時停止中かどうか。この間は♫▶だけが「再開」ボタンとして
  // 機能し（onResumeSyncPlayback）、通常▶/▶▶はApp側で既にdisabled（canPlay/canPlayContinuousが
  // false）になっている。ここでは♫▶ボタン自体のdisabled・onClick・titleの出し分けに使う。
  const syncPlaybackPausedActive = syncPlaybackActive && syncPlaybackPaused;

  // 左端主表示整理 v1：同期再生中（一時停止中も含む＝syncPlaybackActive）は、左端の主表示を
  // 従来の構成側ステータス（statusLabel.main）から、現在の音楽位置（musicPlaybackPositionLabel。
  // 「♫ 1曲目　9エイト目・2カウント目」「♫ 1曲目　イントロ」等）へ入れ替える。通常▶/▶▶（同期
  // していない）では従来通りstatusLabel.mainを主表示にする（playbackStatusLabelの生成ロジック・
  // formatMusicPlaybackPositionLabelの書式はどちらも一切変更しない。ここはUIレベルの「どちらを
  // 主表示として選ぶか」の切替だけを行う表示専用の派生値で、再生state・workへは保存しない）。
  const primaryPlaybackStatusLabel =
    syncPlaybackActive && musicPlaybackPositionLabel != null
      ? musicPlaybackPositionLabel
      : statusLabel
      ? statusLabel.main
      : `${currentIndex + 1} / ${slides.length}`;

  // 削除ボタンだけは「押せる／押せない」で色を変える（危険操作なので押せる時だけ赤枠にする）。
  // 構成の切替・追加・削除・並べ替え（＝navLocked）は「実際に再生中（playing）」の間だけ
  // 無効化する。一時停止中（paused）はスクラバー確認や、別構成へ移動して一時停止を
  // 解除する操作を許可するため、ここではロックしない（手動で構成を切り替えた場合は
  // App側のuseEffectで再生・一時停止状態とscrubProgressが自動的にリセットされる）。
  const navLocked = isPlaying;
  const deleteBtnStyle = canDeleteSlide && !navLocked
    ? { background: THEME.panelBg2, border: `1px solid ${THEME.danger}`, color: THEME.danger }
    : compositionNavBtnStyle(true);
  // 再生ボタン：再生可能なときだけアクセント色にする（idle・paused両方で有効、playing中はdisabled）
  const playBtnStyle = canPlay
    ? { background: THEME.accent, color: "#141318", border: `1px solid ${THEME.accent}` }
    : compositionNavBtnStyle(true);
  // 一時停止ボタン：実際に再生中（playing）の間だけ有効にする
  const pauseBtnStyle = isPlaying
    ? { background: THEME.panelBg2, border: `1px solid ${THEME.danger}`, color: THEME.danger }
    : compositionNavBtnStyle(true);
  // 連続再生（▶▶）ボタン：単体再生（▶）と混同しないよう見た目は控えめにする
  // （アクセント色ではなく、押せる時だけテキスト色をはっきりさせる程度に留める）。
  const continuousBtnStyle = canPlayContinuous
    ? { background: THEME.panelBg2, border: `1px solid ${THEME.accent}`, color: THEME.accent }
    : compositionNavBtnStyle(true);

  // 移動カウントの編集（±ボタン・数値入力）は、再生中・一時停止中のどちらも無効化する
  // （途中経過を表示している最中に、その遷移自体の時間設定を変えられると混乱するため）。
  const countEditLocked = dataEditLocked;

  // ------------------------------------------------------------
  // 構成カードのドラッグ＆ドロップ並べ替え（外部ライブラリ不使用・HTML5 Drag and Drop APIのみ）
  // ------------------------------------------------------------
  // ここで持つのは「ドラッグ中かどうか」「どこへ挿入されようとしているか」という
  // 純粋に一時的なUI stateのみ。実際のslides配列の書き換えは行わず、ドロップ確定時に
  // 既存の moveSlide(fromIndex, toIndex)（＝onReorder）を1回呼び出すだけにする。
  // これにより、選択中インデックスの追従・transitionCountsの再計算・Undo履歴への
  // 積み方（1回のcommit＝1件の履歴）は、既存のmoveSlideのロジックがそのまま適用される。
  const [dragIndex, setDragIndex] = useState(null);
  // dropBeforeIndex: 「現在表示されている並び順」における挿入位置（0〜slides.length）。
  // 値iは「今の並びでインデックスiのカードの直前に挿入される」ことを表す
  // （i===slides.lengthは末尾へ挿入）。
  const [dropBeforeIndex, setDropBeforeIndex] = useState(null);
  const scrollContainerRef = useRef(null);

  // Bottom Control Bar v2.1・9章：CompositionBar自身の実測幅をResizeObserverで
  // 監視し、0（フル表示・3カード）→1（「編集に戻る」表示短縮＋gap圧縮、3カードのまま）→
  // 2（近隣カードを現在の1枚のみへ縮退＝最終手段）の3段階で縮退レベルを決める。
  // 比較対象のCOMPOSITION_BAR_COMPACT_THRESHOLD_1/2はモジュールスコープの定数で、
  // 各ゾーンの積み上げ幅から算出済み（レイアウトの見積りとResizeObserverの判定基準を
  // 同じ定数で一元管理し、二重管理を避ける）。コールバック内ではReact stateの更新
  // （setCompactLevel）以外は一切行わず、document/bodyのスクロールやscrollIntoViewは
  // 呼ばない（v1で問題になった「画面全体がズレる」症状の再発防止）。
  const barRef = useRef(null);
  const [compactLevel, setCompactLevel] = useState(0);
  useEffect(() => {
    const el = barRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver((entries) => {
      const entry = entries && entries[0];
      const width = entry && entry.contentRect ? entry.contentRect.width : el.clientWidth;
      setCompactLevel(decideCompositionBarCompactLevel(width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const cbCompactLevel1 = compactLevel >= 1;
  const cbCompactLevel2 = compactLevel >= 2;

  // UI Stability & Bottom Navigation v1・PART B-1：現在構成＋近隣構成（最大
  // NEARBY_SLIDE_WINDOW_SIZE=5枚）だけの固定ウィンドウ。currentIndex・slides.lengthが
  // 変化した時だけ再計算する。computeNearbySlideIndices自体はDOM非依存のpure関数。
  const nearbyIndices = useMemo(
    () => computeNearbySlideIndices(currentIndex, slides.length, NEARBY_SLIDE_WINDOW_SIZE),
    [currentIndex, slides.length]
  );

  // ------------------------------------------------------------
  // UI Stability & Bottom Navigation v1・PART A・B：
  // 「現在構成への自動横スクロール」機構（cardElementsRef・getCardRefSetter・
  // scrollIntoView()を使うuseEffect）は、今回丸ごと撤去した。
  // 根本原因調査の結果、構成切替時にアプリ全体（document/body）がズレて見える症状は、
  // ここにあった el.scrollIntoView({ behavior, block:"nearest", inline:"center" }) が
  // 原因だった。scrollIntoView()は「対象要素を含むスクロール可能な祖先すべて」を
  // 対象に、必要なら祖先方向へ次々とスクロールを試みる仕様のため、CompositionBar自身の
  // 横スクロール領域だけでなく、状況によっては外側のレイアウト（documentElement/body等）
  // まで巻き込んで動かしてしまうことがあった（＝今回の「画面全体がズレる」症状）。
  // 下記のPART Bで「現在構成＋近隣構成（最大5枚）だけを固定表示するウィンドウ」へ
  // 変更したことで、現在構成のカードは常に表示範囲内に収まるようになり、
  // スクロールで追従させる処理自体が構造的に不要になった（＝scrollIntoViewを
  // 「使わないようにする」のではなく「使う理由が無くなった」ことで安全に撤去できた）。
  const clearDragState = useCallback(() => {
    setDragIndex(null);
    setDropBeforeIndex(null);
  }, []);

  const handleCardDragStart = useCallback(
    (e, index) => {
      if (navLocked) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.effectAllowed = "move";
      // 一部ブラウザではdataTransferにデータをセットしないとドラッグが開始されないため設定する
      // （実際の並べ替え判定にはコンポーネント内のstateを使い、これは使わない）。
      e.dataTransfer.setData("text/plain", String(index));
      setDragIndex(index);
    },
    [navLocked]
  );

  const handleContainerDragOver = useCallback(
    (e) => {
      if (navLocked || dragIndex == null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";

      // PART A・B：近隣構成カード（最大5枚）だけの固定ウィンドウ表示になったため、
      // バーの左右端に近づけて自動横スクロールする処理は不要になった（横スクロール自体が
      // 無いため）。旧実装にあったcontainer.scrollLeftの操作は撤去した。

      // どのカードの前/後に挿入するかを、ホバー中のカード要素とカーソルのx座標から判定する。
      const cardEl = e.target && e.target.closest ? e.target.closest("[data-slide-index]") : null;
      if (cardEl) {
        const idx = parseInt(cardEl.dataset.slideIndex, 10);
        const cardRect = cardEl.getBoundingClientRect();
        const insertBefore = e.clientX < cardRect.left + cardRect.width / 2;
        setDropBeforeIndex(insertBefore ? idx : idx + 1);
      }
      // カード以外の余白にカーソルがある間は、直前のdropBeforeIndexをそのまま維持する。
      // 近隣ウィンドウ表示では「表示領域の空きスペース＝配列全体の末尾」という意味を
      // 持たなくなったため、無理に位置を決め直さない。
    },
    [navLocked, dragIndex]
  );

  const handleContainerDrop = useCallback(
    (e) => {
      if (navLocked) return;
      e.preventDefault();
      const from = dragIndex;
      const before = dropBeforeIndex;
      clearDragState();
      if (from == null || before == null) return;
      // 「削除してから挿入する」moveSlideの仕様に合わせて、削除後のインデックスへ変換する。
      let target = before;
      if (target > from) target -= 1;
      if (target !== from) onReorder(from, target);
    },
    [navLocked, dragIndex, dropBeforeIndex, clearDragState, onReorder]
  );

  return (
    <div
      ref={barRef}
      style={{
        height: 88,
        flexShrink: 0,
        marginTop: 10,
        background: THEME.panelBg,
        border: `1px solid ${THEME.border}`,
        borderRadius: 12,
        padding: "8px 8px", // Bottom Control Bar v2.2：左右paddingを10px→8pxへ詰めた（CB_BAR_PADDING_X参照）
        display: "flex",
        alignItems: "center",
        gap: CB_ZONE_GAP,
      }}
      className={`slsim-composition-bar${cbCompactLevel1 ? " slsim-cb-compact-1" : ""}${
        cbCompactLevel2 ? " slsim-cb-compact-2" : ""
      }`}
    >
      {/* Bottom Control Bar v2.1・3章：LEFTゾーン＝「現在位置（◀ n/total ▶）」と
          「再生操作」をまとめる。どちらも“時間・構成方向への進行”という同じ役割のため、
          間の区切り線は廃止しgapだけで軽く分ける（6章：不要な区切り線・余白の整理）。
          このゾーン全体はshrink-0固定で、CENTER/RIGHTを圧迫しないぶん自身も縮まない。 */}
      <div
        className="flex items-center shrink-0"
        style={{ gap: cbCompactLevel1 ? CB_LEFT_ZONE_GAP_COMPACT : CB_LEFT_ZONE_GAP_FULL }}
      >
        <div className="flex items-center shrink-0" style={{ gap: 6 }}>
          <button
            type="button"
            onClick={onPrev}
            disabled={currentIndex <= 0 || navLocked}
            style={compositionNavBtnStyle(currentIndex <= 0 || navLocked)}
            title="前の構成"
            aria-label="前の構成"
            className="w-8 h-8 rounded-lg font-bold text-base flex items-center justify-center shrink-0"
          >
            ◀
          </button>

          {/* PART A：一時停止表示の2行化。1行目（main）はplaying/pausedで完全に同一の内容にし、
              「（一時停止中）」は常に確保された2行目へ表示する。一時停止でない時（idle/playing）も
              2行目のspan自体は常にレンダリングし、visibilityだけで出し分けることで、
              一時停止のON/OFFでバーの高さ・1行目の横幅・他の要素の位置が一切変化しないようにする
              （3章：高さの固定は、2行目を消す/出すのではなくvisibility切替で実現する）。
              左端主表示整理 v1：1行目の内容は、同期再生中はprimaryPlaybackStatusLabel経由で
              音楽位置（例：「♫ 1曲目　9エイト目・2カウント目」）へ切り替わる。
              左端2行表示 v1：同期再生中（syncPlaybackActive）はさらに2行目も、従来の
              pauseだけの表示から、syncAnimationStatusLabel（構成側の進行状況。「1 キープ
              3/8 count」「1 → 2　移動 2/4 count」）へ切り替える（8章）。同期pause中は、その
              構成進行ラベルの末尾へ「（一時停止）」を小さく添えるだけで、3行にはしない
              （9章）。preroll中（構成アニメーションがまだ始まっていない）はsyncAnimationStatusLabel
              がnullになるため、2行目はvisibility:hiddenで高さだけ確保した空欄になる（7章）。
              通常▶/▶▶（syncPlaybackActive===false）では、2行目は既存仕様のまま
              （statusLabel.isPausedで「（一時停止中）」を出し分けるだけ）で一切変更しない
              （12章）。
              左端ブロックの横幅は、同期再生中はwidth/minWidthとも220pxに固定し
              （flexShrink:0と合わせ、伸び縮みしない）、keep→move切替・構成番号やカウントの
              桁数変化で右隣の再生操作群が横へ動かないようにする（10章）。1行目・2行目とも
              overflow:hidden・textOverflow:ellipsisを付け、Section名が長い場合に固定幅を
              突き抜けて隣のUIへ重ならないようにする（11章：表示文字列自体、
              formatMusicPlaybackPositionLabelの書式は変更していない）。 */}
          <div
            style={{
              minWidth: syncPlaybackActive ? 220 : 64,
              width: syncPlaybackActive ? 220 : undefined,
              flexShrink: 0,
            }}
            className="flex flex-col justify-center shrink-0 slsim-composition-status"
          >
            {/* UI Stability & Bottom Navigation v1・PART B-3：構成番号が1桁→2桁→3桁と
                増えてもバー全体の幅・位置ができるだけ変化しないよう、この「n / 全n」表示にも
                font-variant-numeric: tabular-nums（等幅数字）を適用し、「100 / 100」でも
                収まるよう最小幅を64pxへ拡げてある（v2.1・11章）。 */}
            <span
              style={{
                color: THEME.textDim,
                fontVariantNumeric: "tabular-nums",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              className="text-xs font-bold whitespace-nowrap block"
            >
              {primaryPlaybackStatusLabel}
            </span>
            <span
              style={{
                color: THEME.textDim,
                fontSize: 10,
                lineHeight: 1.4,
                opacity: 0.75,
                overflow: "hidden",
                textOverflow: "ellipsis",
                visibility: syncPlaybackActive
                  ? syncAnimationStatusLabel != null
                    ? "visible"
                    : "hidden"
                  : statusLabel && statusLabel.isPaused
                  ? "visible"
                  : "hidden",
              }}
              className="whitespace-nowrap block"
            >
              {syncPlaybackActive ? (
                syncAnimationStatusLabel != null && (
                  <>
                    {syncAnimationStatusLabel}
                    {syncPlaybackPaused && "　（一時停止）"}
                  </>
                )
              ) : (
                /* Music Sync Playback v1・37章：同期セッションの一時停止中だけ文言を変える。
                   visibilityでの出し分け自体（＝一時停止のON/OFFで高さが変化しない仕組み）は
                   既存のままで、中の文字列だけをsyncPlaybackPausedで切り替える。 */
                <>{syncPlaybackPaused ? "（同期・一時停止中）" : "（一時停止中）"}</>
              )}
            </span>
          </div>

          <button
            type="button"
            onClick={onNext}
            disabled={currentIndex >= slides.length - 1 || navLocked}
            style={compositionNavBtnStyle(currentIndex >= slides.length - 1 || navLocked)}
            title="次の構成"
            aria-label="次の構成"
            className="w-8 h-8 rounded-lg font-bold text-base flex items-center justify-center shrink-0"
          >
            ▶
          </button>
        </div>

        {/* コンパクトな再生操作：▶ 単体再生（現在の構成→次の構成だけ）／▶▶ 連続再生
            （現在の構成から最後の構成まで、キープと移動を交互に）／⏸ 一時停止。
            最後の構成を選択中は canPlay が false になり単体再生ボタンがdisabledになる。
            ▶・▶▶ とも、idle（scrubProgress=0なら最初から、>0ならその位置から＝▶のみ）・
            paused（一時停止位置から再開）のどちらでも押せる。一時停止中は、押したボタンに関わらず
            「今止まっているセッション」がそのまま再開される（単体・連続が切り替わることはない）。
            ⏸は実際に再生中（playing）の間だけ有効。
            Sync Playback v1.6・2〜3・32章：ただし「音楽＋アニメーション同期再生」の一時停止中
            （syncPlaybackPausedActive）だけは例外で、canPlay/canPlayContinuousはApp側で
            あらかじめfalseにされている（このボタンでは同期セッションを再開させない＝♫▶だけが
            再開の入口）。titleもその場合だけ理由を明示する。 */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={onPlay}
            disabled={!canPlay}
            style={playBtnStyle}
            title={
              canPlay
                ? isPaused
                  ? "一時停止位置から再開"
                  : "現在の構成→次の構成を再生"
                : syncPlaybackPausedActive
                ? "同期一時停止中は♫▶から再開してください"
                : "最後の構成のため再生できません"
            }
            aria-label="再生"
            className="w-8 h-8 rounded-lg font-bold text-sm flex items-center justify-center"
          >
            ▶
          </button>
          <button
            type="button"
            onClick={onPlayContinuous}
            disabled={!canPlayContinuous}
            style={continuousBtnStyle}
            title={
              canPlayContinuous
                ? isPaused
                  ? "一時停止位置から連続再生を再開"
                  : "現在の構成から最後の構成まで連続再生"
                : syncPlaybackPausedActive
                ? "同期一時停止中は♫▶から再開してください"
                : "連続再生できる構成がありません"
            }
            aria-label="連続再生"
            className="w-8 h-8 rounded-lg font-bold text-sm flex items-center justify-center"
          >
            ▶▶
          </button>
          {/* Music Sync Playback v1・1〜3章：「現在の構成から、音楽と構成アニメーションを同期して
              再生」する新しいボタン。既存の▶/▶▶とは別物として追加し、既存の2ボタンは変更しない。
              musicAnchor未設定・音源未読込・duration超過のいずれかがあればdisabledにし、
              titleへ理由を表示する（2・3・32章）。27章の通り、通常の単体/連続
              再生が実行中でもこのボタン自体はdisabledにせず、押した時点でApp側のstartSyncPlayback
              が既存の再生ループを安全に止めてから同期再生へ切り替える。
              Sync Playback v1.6・2〜9・32章：同期一時停止中（syncPlaybackPausedActive）は、
              従来disabledにしていたこのボタンを逆に有効化し、「音楽＋アニメーション同期再生の
              再開」専用ボタンとして機能させる（onResumeSyncPlayback）。これにより一時停止中は
              ♫▶だけが再開の入口になり、通常▶/▶▶はApp側で既にdisabledにしてある（PART A）。 */}
          <button
            type="button"
            onClick={syncPlaybackPausedActive ? onResumeSyncPlayback : onStartSyncPlayback}
            disabled={syncPlaybackPausedActive ? false : !canStartSyncPlayback || syncPlaybackActive}
            style={
              syncPlaybackPausedActive || (canStartSyncPlayback && !syncPlaybackActive)
                ? { background: THEME.panelBg2, border: `1px solid ${THEME.accent}`, color: THEME.accent }
                : compositionNavBtnStyle(true)
            }
            title={
              syncPlaybackPausedActive
                ? "音楽＋アニメーションを再開"
                : syncPlaybackActive
                ? "同期再生中です"
                : canStartSyncPlayback
                ? "音楽と同期して再生"
                : syncPlaybackBlockedReason
            }
            aria-label={syncPlaybackPausedActive ? "音楽＋アニメーションを再開" : "音楽と同期して再生"}
            className="w-8 h-8 rounded-lg font-bold text-sm flex items-center justify-center"
          >
            ♫▶
          </button>
          <button
            type="button"
            onClick={onPause}
            disabled={!isPlaying}
            style={pauseBtnStyle}
            title="一時停止"
            aria-label="一時停止"
            className="w-8 h-8 rounded-lg font-bold text-sm flex items-center justify-center"
          >
            ⏸
          </button>
          {/* PART B：「編集に戻る」。一時停止中だけ意味を持ち（7章）、再生中・idle時は使えない。
              一時停止（保持して後で再開）とは明確に区別するため、「停止」ではなく
              「編集に戻る」という名称にする（6章）。押すとApp側のreturnToEdit()＝
              既存forceIdle()が呼ばれ、再生セッション終了・scrubProgress=0・
              正式なslide.placementsの再表示・編集ロック解除が行われる（8章）。
              Bottom Control Bar v2・13章：以前は{"{isPaused && <button>...}"}で条件付きマウント
              していたため、一時停止のON/OFFで再生操作ブロック自体の幅が変化していた問題を
              修正済み（ボタン自体は常にマウントし、visibility・pointerEventsだけで出し分ける）。
              v2.1・13章：LEFTゾーンの幅自体を一時停止のON/OFFで変えないという要件は
              変わらないため、この「常時マウント」方式は維持する。cbCompactLevel1中は
              テキストを削りアイコンのみにして幅を詰める（10章：テキスト簡略化を
              近隣カード縮退より先に行う）が、この短縮自体も一時停止状態には依存せず
              compactLevelだけで決まるため、LEFTゾーンの幅はここでも変化しない。 */}
          <button
            type="button"
            onClick={onReturnToEdit}
            disabled={!isPaused}
            style={{
              background: THEME.panelBg2,
              border: `1px solid ${THEME.border}`,
              color: THEME.text,
              visibility: isPaused ? "visible" : "hidden",
              pointerEvents: isPaused ? "auto" : "none",
            }}
            title="再生セッションを終了して編集に戻ります（途中位置は保存されません）"
            aria-label="編集に戻る"
            className="h-8 px-2 rounded-lg font-bold text-xs flex items-center justify-center gap-1 shrink-0 whitespace-nowrap"
          >
            {cbCompactLevel1 ? "■" : "■ 編集に戻る"}
          </button>
        </div>
      </div>

      {/* Music Sync Playback v1・36章：UIを大きくしすぎないよう、同期セッション中だけ表示される
          小さなステータス表示。20章（任意）：次slideのmusicAnchorとのズレ（syncDriftSec）が
          計算できていれば、符号付きで小さく添える（自動補正はしない＝19章。表示のみ）。
          Music Timing v1.5・14章：プリロール（イントロ）中はドリフト表示の代わりに
          「イントロ再生中」＋カウント開始までの残り秒数を表示する。既存の2行表示・バーの高さは
          変更しない（1行のバッジ内で完結させる）。
          左端主表示整理 v1：以前はここに音楽位置（「♫ 1曲目　9エイト目・2カウント目」等）も
          主表示として重複して出していたが、左端主表示（primaryPlaybackStatusLabel）へ一本化した
          ため、ここは「同期再生中／一時停止中」＋プリロール残り秒／ドリフト表示だけを補助
          ステータスとして残す（4章：同じ情報を2箇所に表示しない）。表示対象は同期セッション中
          （syncPlaybackActive）だけで、通常アニメーション再生中はここには何も表示しない
          （左端の主表示だけで完結させる）。既存のイントロ残り秒・ドリフト表示は一切削除しない
          （5章）。位置自体は既存のまま（再生ボタン群の直後・CENTERゾーンとの境界の手前）で、
          大規模なflex再設計はしていない（6章）。 */}
      {syncPlaybackActive && (
        <span
          style={{ color: THEME.textDim, fontSize: 10, fontWeight: 700, flexShrink: 0 }}
          className="whitespace-nowrap"
        >
          {`同期${syncPlaybackPaused ? "一時停止中" : "再生中"}`}
          {syncPlaybackPreroll ? (
            <>
              {" "}
              （イントロ再生中
              {!syncPlaybackPaused && syncPrerollRemainingSec != null && ` ・カウント開始まで ${syncPrerollRemainingSec.toFixed(1)}秒`}
              ）
            </>
          ) : (
            syncDriftSec != null && (
              <>
                {" "}
                （差 {syncDriftSec >= 0 ? "+" : ""}
                {syncDriftSec.toFixed(2)}秒）
              </>
            )
          )}
        </span>
      )}

      <div style={{ width: CB_DIVIDER_WIDTH, height: 40, background: THEME.border }} className="shrink-0" />

      {/* Bottom Control Bar v2.1・3・4・5章：CENTERゾーン＝「移動時間（Transition）」と
          「近隣構成カード」をまとめる。ゾーン自体はflex:"1 1 auto"でバーの余白を
          広がって使うが、minWidth:0は指定しない（＝ブラウザ既定のminWidth:autoのまま）ため、
          中身（Transition＋Nearbyの自然な最小幅の合計）より縮むことは無い。これがv2の
          「flex:1・minWidth:0で残りスペースだけ割り当て、狭ければカードを隠す」設計から
          「最初から必要な最小幅を尊重する」設計への転換の核心（5章）。 */}
      <div
        className="flex items-center justify-center"
        style={{ flex: "1 1 auto", gap: CB_CENTER_ZONE_GAP }}
      >
        {/* 「現在の構成 → 次の構成」の移動カウント（ダンスの8カウント＝1エイト単位）。
            最後の構成（次が無い）、または再生中・一時停止中（dataEditLocked）はdisabledにする。
            バーの高さを増やさないようラベル・±ボタン・エイト換算を縦にコンパクトに詰めた
            3行構成にしてある。 */}
        <div
          className="flex flex-col items-center justify-center shrink-0"
          style={{ minWidth: CB_TRANSITION_BLOCK_MIN_WIDTH, gap: 1 }}
          title={!hasNextSlideForTransition ? "次の構成がないため設定できません" : undefined}
        >
          <span style={{ color: THEME.textDim, fontSize: 10, lineHeight: 1 }}>移動時間</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onStepTransitionCounts(-1)}
              disabled={!hasNextSlideForTransition || countEditLocked}
              style={compositionNavBtnStyle(!hasNextSlideForTransition || countEditLocked)}
              title="1カウント減らす"
              aria-label="移動カウントを1減らす"
              className="w-6 h-6 rounded font-bold text-xs flex items-center justify-center"
            >
              −
            </button>
            <input
              type="text"
              inputMode="numeric"
              value={hasNextSlideForTransition ? transitionCountsDraft.displayValue : ""}
              disabled={!hasNextSlideForTransition || countEditLocked}
              onFocus={transitionCountsDraft.handleFocus}
              onChange={transitionCountsDraft.handleChange}
              onBlur={transitionCountsDraft.handleBlur}
              onKeyDown={transitionCountsDraft.handleKeyDown}
              style={{
                width: 34,
                background: THEME.panelBg2,
                border: `1px solid ${THEME.border}`,
                color: THEME.text,
                textAlign: "center",
                borderRadius: 4,
                fontSize: 12,
                padding: "1px 2px",
              }}
            />
            <span style={{ color: THEME.textDim, fontSize: 11 }}>count</span>
            <button
              type="button"
              onClick={() => onStepTransitionCounts(1)}
              disabled={!hasNextSlideForTransition || countEditLocked}
              style={compositionNavBtnStyle(!hasNextSlideForTransition || countEditLocked)}
              title="1カウント増やす"
              aria-label="移動カウントを1増やす"
              className="w-6 h-6 rounded font-bold text-xs flex items-center justify-center"
            >
              ＋
            </button>
          </div>
          <span style={{ color: THEME.textDim, fontSize: 10, lineHeight: 1 }}>
            {hasNextSlideForTransition ? `（${formatEighthsLabel(transitionCounts)}）` : " "}
          </span>
        </div>

        {/* Bottom Control Bar v2.1・4章：近隣構成ナビゲーション（最大
            NEARBY_SLIDE_WINDOW_SIZE=3枚：基本は「前・現在・次」）。横スクロールは持たせず
            常に固定幅カードだけで構成する。
            幅は「余ったら表示」ではなく最初から固定で予約する（NEARBY_CARDS_RESERVED_WIDTH＝
            3枚ぶんのカード幅＋gap。最重要要件：1章）。cbCompactLevel2（最終手段）の時だけ、
            JS側でこの幅自体をカード1枚ぶんへ縮め、同時にCSS側
            （.slsim-cb-compact-2 .slsim-nearby-card:not(.slsim-nearby-card-active)）で
            非活性カードをdisplay:noneにする（幅と表示、両方が矛盾なく1枚分に揃う）。
            className="slsim-composition-nearby"（RESPONSIVE_STYLES側でoverflow:hiddenを
            指定）は、ドラッグ中の挿入インジケーターなど瞬間的なはみ出しがあっても
            右隣のRIGHTゾーンへ視覚的に漏れないための保険として維持する（v2で修正した
            干渉バグの再発防止）。
            ドラッグ＆ドロップでの並べ替えは「現在表示されている近隣カード同士」の間でのみ
            引き続き可能（挿入位置はアクセント色の縦線で示す、既存のまま）。遠い構成への
            ジャンプは既存の「構成一覧」モーダル（▦ボタン）の役割のまま。 */}
        <div
          ref={scrollContainerRef}
          onDragOver={handleContainerDragOver}
          onDrop={handleContainerDrop}
          style={{
            width: cbCompactLevel2 ? SLIDE_CARD_WIDTH : NEARBY_CARDS_RESERVED_WIDTH,
            flexShrink: 0,
            height: "100%",
            justifyContent: "center",
          }}
          className="flex items-center gap-1.5 slsim-composition-nearby"
        >
          {nearbyIndices.map((i) => {
            const s = slides[i];
            return (
              <React.Fragment key={s.id}>
                {dropBeforeIndex === i && dragIndex !== null && <DropInsertionIndicator />}
                <SlideCard
                  index={i}
                  slide={s}
                  active={i === currentIndex}
                  onClick={() => {
                    if (navLocked) return;
                    onSelect(i);
                  }}
                  locked={navLocked}
                  dragging={dragIndex === i}
                  onDragStart={(e) => handleCardDragStart(e, i)}
                  onDragEnd={clearDragState}
                />
              </React.Fragment>
            );
          })}
          {/* B-2：近隣ウィンドウ表示では「表示領域の末尾＝配列全体の末尾」という意味を
              持たなくなったため、末尾への挿入インジケーターは、表示中の最後のカードの
              直後（＝nearbyIndicesの最後の要素+1）への挿入としてのみ意味を持たせる。 */}
          {nearbyIndices.length > 0 &&
            dropBeforeIndex === nearbyIndices[nearbyIndices.length - 1] + 1 &&
            dragIndex !== null && <DropInsertionIndicator />}
        </div>
      </div>

      <div style={{ width: CB_DIVIDER_WIDTH, height: 40, background: THEME.border }} className="shrink-0" />

      {/* RIGHTゾーン：作成・削除・一覧表示・PNG出力。「複製」は「＋ 新しい構成を追加」に
          役割を統合したため廃止した。ボタンが増えたためアイコン中心の正方形ボタンに
          してある（高さは他のボタンと揃えつつ幅を切り詰め、バー全体の高さは変えない）。
          このゾーンは近隣カードの枚数に関わらず常にshrink-0固定幅・同じ位置に表示される。
          v2.2：ボタン間gapを6px（gap-1.5）→4px（CB_MANAGEMENT_ZONE_GAP）へ詰めた
          （ボタン自体のサイズ・機能は変更していない）。 */}
      <div className="flex items-center shrink-0" style={{ gap: CB_MANAGEMENT_ZONE_GAP }}>
        <button
          type="button"
          onClick={onAddNew}
          disabled={navLocked}
          style={navLocked ? compositionNavBtnStyle(true) : compositionActionBtnStyle}
          title="新しい構成を追加"
          aria-label="新しい構成を追加"
          className="w-8 h-8 rounded-lg font-bold text-base flex items-center justify-center"
        >
          ＋
        </button>
        <button
          type="button"
          onClick={onDeleteSlide}
          disabled={!canDeleteSlide || navLocked}
          style={deleteBtnStyle}
          title={!canDeleteSlide ? "構成が1つしかないため削除できません" : navLocked ? "再生中は削除できません" : "削除"}
          aria-label="選択中の構成を削除"
          className="w-8 h-8 rounded-lg font-bold text-sm flex items-center justify-center"
        >
          🗑
        </button>
        <button
          type="button"
          onClick={onShowList}
          style={compositionActionBtnStyle}
          title="一覧表示"
          aria-label="一覧表示"
          className="w-8 h-8 rounded-lg font-bold text-sm flex items-center justify-center"
        >
          ▦
        </button>
        {/* Export Center v1：構成一覧ボタン（▦）のすぐ隣に配置する「出力」ボタン。下部操作バーの
            ボタン数は増やさず、既存のPNG出力ボタンをExport Centerモーダルへの入口として
            一本化した（1章）。クリックしても直接PNGはダウンロードされず、出力対象・表示
            オプション・ビューを選べるExport Centerを開くだけになる。22章：再生中はdisabled
            にする（既存のisTransitionActiveをそのままpngExportDisabledとして受け取る）。 */}
        <button
          type="button"
          onClick={onExportPng}
          disabled={pngExportDisabled}
          style={pngExportDisabled ? compositionNavBtnStyle(true) : compositionActionBtnStyle}
          title={pngExportDisabled ? "再生中は出力できません" : "出力（PNG）"}
          aria-label="出力"
          className="w-8 h-8 rounded-lg font-bold text-sm flex items-center justify-center"
        >
          ⭳
        </button>
      </div>
    </div>
  );
}

// 構成バー内の1枚分の小さなカード。サムネイル画像は今回は未実装（将来ここに差し込む想定）。
// 挿入位置を示す、アクセント色の細い縦線。ドラッグ中のみカードの間に描画される。
function DropInsertionIndicator() {
  return (
    <div
      style={{
        width: 3,
        height: 54,
        background: THEME.accent,
        borderRadius: 2,
        flexShrink: 0,
      }}
      aria-hidden="true"
    />
  );
}

// 構成バー内の1枚分の小さなカード（ドラッグ＆ドロップで並べ替え可能）。
// 従来（64×64px）よりひと回りコンパクトにし、横スクロールなしで一度に表示できる
// 構成数を増やしている。サムネイル画像は今回は未実装（将来ここに差し込む想定）。
// UI Stability & Bottom Navigation v1・PART A：以前はここへ「現在構成への自動横スクロール」
// 用のinnerRef（cardElementsRef経由でscrollIntoViewする対象）を渡していたが、
// 近隣ウィンドウ表示（常に現在構成が表示範囲内）になったことで不要になったため撤去した。
function SlideCard({ index, slide, active, onClick, locked, dragging, onDragStart, onDragEnd }) {
  // カードには順番番号のみを表示する（構成名は右側の編集パネルで確認・編集する）。
  // title/aria-labelには構成名を残し、ホバーやスクリーンリーダーでは分かるようにしてある。
  const label = String(index + 1);
  return (
    <button
      type="button"
      data-slide-index={index}
      draggable={!locked}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      disabled={locked}
      title={locked ? "再生中は構成を切り替えられません" : `${slide.name}（ドラッグで並べ替え）`}
      aria-label={`${label}番目の構成：${slide.name}`}
      style={{
        background: active ? THEME.accent : THEME.panelBg2,
        color: active ? "#141318" : THEME.text,
        border: `1px solid ${active ? THEME.accent : THEME.border}`,
        opacity: dragging ? 0.4 : locked && !active ? 0.5 : 1,
        cursor: locked ? "not-allowed" : "grab",
        width: 50,
        height: 54,
      }}
      className={`shrink-0 rounded-lg flex items-center justify-center slsim-nearby-card${active ? " slsim-nearby-card-active" : ""}`}
    >
      {/* B-3：構成番号が1桁→2桁→3桁になってもカード内の見え方が大きく揺れないよう
          tabular-numsを適用する（カード自体の幅は既存どおり固定50pxのまま）。
          Bottom Control Bar v2・10章：slsim-nearby-card / slsim-nearby-card-active の
          className（RESPONSIVE_STYLES参照）は、狭い画面で「現在の1枚だけ残す」段階的
          縮退のために使う。並び順（window内のどの位置か）ではなく「現在構成かどうか」で
          判定するため、ウィンドウが配列の端に寄っていても常に正しく現在カードだけが残る。 */}
      <span style={{ fontSize: 18, fontVariantNumeric: "tabular-nums" }} className="font-bold">
        {label}
      </span>
    </button>
  );
}

// ------------------------------------------------------------------
// 構成一覧 v1
// ------------------------------------------------------------------
// 「一覧表示」ボタンから開くモーダル。各構成をカード状（構成番号・構成名・
// FormationThumbnail）に並べたグリッド一覧を表示し、クリックでその構成へ移動する。
// 新しい別モーダルは作らず、既存のこのモーダルをそのまま拡張する（1章）。
//   ・カードクリックは既存goToSlide()をそのまま呼ぶだけ（12章）。currentSlideIndexを
//     直接setする処理はここには一切無い。goToSlide自体がupdateWorkLiveを使う既存実装の
//     ままのため、Undo/Redo履歴は増えない（15章）。
//   ・クリック後は構成へ移動した上でモーダルを閉じる（13章）。
//   ・isTransitionActive（構成アニメーション再生中・一時停止中・Sync Playback中のいずれも
//     trueになる既存の値）の間は、モーダル自体は開けるがカードをdisabledにする（14章）。
//   ・各カードのサムネイルはFormationThumbnailへ現在のslide.placements/performers/stage/zones
//     をそのまま渡すだけで、専用のサムネイル画像生成・保存は一切行わない（17章）。
//   ・表示順は常にslides配列の順序そのまま（20章：構成バーの並べ替え後もこの一覧が
//     Single Source of Truthとして自動的に追従する）。
//
// カードサイズ固定 v1.1：
// 以前の実装は「ヘッダーを除いた残り部分」を1つのdivに
// overflowY:"auto" + flex:1 + display:"grid" をまとめて指定していた。この1つのdivは
// 同時に（a）縦方向フレックスアイテム（flex:1）と（b）グリッドコンテナの2つの役割を
// 兼ねていたが、min-height:0 を明示していなかったため、構成数が増えて中の
// グリッド行（auto sizing）の合計コンテンツ高さが、モーダルの残り高さ（flexで
// 決まる固定値）を超えても、はみ出して縦スクロールする側ではなく、その固定の
// 残り高さの中に収めようとする側で解決されてしまい、結果としてgrid-auto-rowsの
// 各行（＝カード）が構成数に応じて圧縮されていた（3章の指摘どおり、flexの
// 縮小計算とgridの行サイズ計算が同じ要素の中でせめぎ合っていたことが原因）。
// これを避けるため、「縦方向にflexで伸び縮みしてスクロールを担当する層
// （ListViewport：flex:1・min-height:0・overflow-y:auto）」と、「純粋にコンテンツの
// 自然な高さだけで行が決まる層（Grid：height:max-content・align-content:start）」を
// 明確に2枚の要素へ分離した（7章）。align-content:startにより、行数がどれだけ
// 増えてもグリッド自身の中で行の高さを圧縮したり引き伸ばしたりせず、常に
// カード本来の自然な高さ（FormationThumbnailのaspect-ratio 4:3で決まる高さ＋
// 番号・構成名の行の高さ）のまま並び、ListViewport側が縦スクロールを担当する。
function SlideListModal({
  mode = "normal", // "normal"（従来通り：クリック→goToSlide→閉じる）| "export-selection"（Export Center v1）
  slides,
  performers,
  stage,
  zones,
  currentSlideIndex,
  isTransitionActive,
  onSelectSlide,
  onClose,
  musicSections, // 構成一覧 音楽位置表示 v1：PART A・2章。既存のgetMusicSections(work)の結果をそのまま渡す
  transitionCounts, // 同上。既存のwork.transitionCountsをそのまま渡す（新しいstateは作らない）
  // Export Center v1・6・8・9章：出力用選択モードでのみ使用する。normalモードでは未使用。
  selectedSlideIds, // 選択中のslide.id配列（Export Center専用のUI一時state。work等には保存しない）
  onToggleSlideSelection, // (slideId) => void
  onSelectAllSlides, // () => void
  onClearSlideSelection, // () => void
  // 構成一覧v2・第1段階：normalモードでのみ使用する構成管理操作。export-selectionモードでは
  // 一切呼ばれない（渡されていても無視される）。
  onDuplicateSlide, // (index) => void。既存のpasteCopiedSlideと同じreconcile方針で複製する
  onRequestDeleteSlide, // (index) => void。App側で確認モーダル（ConfirmDeleteSlideModal）を開くだけ
  onReorderSlide, // (fromIndex, toIndex) => void。既存のmoveSlide（CompositionBarのDnDと共通）をそのまま使う
  canDeleteSlide, // 最後の1構成かどうか（App側のslides.length>1をそのまま渡す）
  // 構成一覧v2・第2段階①：任意位置への構成コピー＆ペースト。normalモードのみで使用する。
  copiedSlideId, // コピー中の構成のid（null=コピーなし）。work等には保存しないUI一時state
  onCopySlide, // (index) => void。押した瞬間はwork変更なし＝Undo履歴を作らない
  onPasteSlideAfter, // (index) => void。この構成の直後へclipboardの構成を挿入する（1回のUndo履歴。
  // 複数構成一括コピー v1・STEP12：bulk clipboardが存在する場合はApp側でbulk pasteへ自動的に
  // 委譲される＝pasteAfterIndexUnified。SlideListModal側はこの関数を呼ぶだけでよい）。
  onClearCopiedSlide, // () => void。コピーstateを解除するだけ（Undo履歴に入らない）
  // 構成一覧v2・第2段階②：貼り付け直後の一時強調。normalモードのみで使用する。
  recentlyPastedSlideId, // 直近で貼り付けられたslideのid（約1秒後にnullへ戻る）。work等には保存しないUI一時state
  // 複数構成一括コピー v1・STEP1：normalモード内の「選択モード」で使う。選択モードON/OFF自体は
  // このコンポーネントのローカルstate（下記selectionModeActive）で持ち、選択されたslide.id配列
  // だけをApp()側（selectedCopySlideIds）へ委譲する（7〜8章の役割分担）。
  selectedCopySlideIds, // 選択中のslide.id配列（App側state）。exportSlideIdsとは完全に別のstate
  onToggleCopySlideSelection, // (slideId) => void
  onSelectAllCopySlides, // () => void
  onClearCopySlideSelection, // () => void
  onBulkCopySlides, // () => void。選択中のselectedCopySlideIdsをclipboardへ保存する（App側で実行）
  // 一括削除 v1：選択モードの「削除」ボタン用。選択自体はselectedCopySlideIds（既存・上記）を
  // そのまま「複数操作用の選択状態」として再利用する（コピー専用の新しいselectedIds stateは
  // 作らない）。
  onRequestBulkDelete, // () => void。削除ボタン押下時。この時点ではまだ削除しない
  // （App側でpendingBulkSlideDeleteIdsへsnapshotを保存し、確認モーダルを開くだけ）。
  pendingBulkDeleteIds, // 確認待ちの削除対象id配列（App側state）。null＝確認モーダル非表示。
  onConfirmBulkDelete, // () => void。確認モーダルの「削除する」。実際の削除（1回のcommitWork）を実行する
  onCancelBulkDelete, // () => void。確認モーダルの「キャンセル」。work変更なし・選択状態は維持する
  // 複数構成一括コピー v1・STEP12：copiedSlideRef（ref）はこのコンポーネントから直接参照できない
  // ため、「直近のコピーが複数選択からの一括コピーだったか」をApp側のreactive stateとして
  // 受け取る。「⋯」メニューの「ここに貼り付け」のdisabled判定にのみ使う（表示専用）。
  hasBulkClipboard,
}) {
  const isExportMode = mode === "export-selection";

  // 複数構成一括コピー v1・STEP1：構成一覧の「選択」モードON/OFF。normalモードの中だけで
  // 意味を持つ、このコンポーネント専用のローカルstate（App()側へliftしない＝7〜8章）。
  // モーダルが閉じて再度開くと（親コンポーネントごとアンマウント／再マウントされるため）
  // 自動的にfalseへ戻る。
  const [selectionModeActive, setSelectionModeActive] = useState(false);
  const isCopySelectionActive = mode === "normal" && selectionModeActive;
  // カードクリック挙動・DnD無効化・「⋯」非表示・選択枠表示など、export-selectionと
  // copy-selectionの両方で共通のUI挙動をまとめて判定するための1つの真偽値（9〜11章：
  // 既存export-selectionパターンを再利用し、UI実装を重複させない）。
  const isMultiSelectMode = isExportMode || isCopySelectionActive;

  const enterCopySelectionMode = useCallback(() => {
    if (onClearCopySlideSelection) onClearCopySlideSelection(); // 前回の選択の残骸を残さない（保険）
    setSelectionModeActive(true);
  }, [onClearCopySlideSelection]);
  const exitCopySelectionMode = useCallback(() => {
    setSelectionModeActive(false);
    if (onClearCopySlideSelection) onClearCopySlideSelection();
  }, [onClearCopySlideSelection]);
  // 「コピー」：selectedCopySlideIds（App側で既に元slides順へ揃えられる想定は無く、App側の
  // copySelectedSlides内でslides.filter()により順序を保証する＝15章）をclipboardへ保存し、
  // 選択状態のクリア・選択モード終了までを1操作で完結させる（二段階操作にしない＝コピー実行後仕様）。
  const handleBulkCopyClick = useCallback(() => {
    if (onBulkCopySlides) onBulkCopySlides();
    setSelectionModeActive(false);
  }, [onBulkCopySlides]);

  // 一括削除 v1・4章：削除ボタンのdisabled条件。selectedCopySlideIds未選択・isTransitionActive中に
  // 加え、「削除すると残り構成数が0になる」場合も不可にする（最低1構成ルール。「全構成選択→
  // 自動的に1構成だけ残す」という暗黙処理はしない＝そのまま削除不可として案内する）。
  const canBulkDelete =
    !isTransitionActive &&
    !!selectedCopySlideIds &&
    selectedCopySlideIds.length > 0 &&
    slides.length - selectedCopySlideIds.length >= 1;
  const bulkDeleteDisabledTitle = isTransitionActive
    ? "再生中は削除できません"
    : !selectedCopySlideIds || selectedCopySlideIds.length === 0
    ? undefined
    : slides.length - selectedCopySlideIds.length < 1
    ? "最低1構成は残す必要があります"
    : undefined;
  // 確認モーダルの「削除する」：実際の削除はApp側のonConfirmBulkDelete（1回のcommitWork）に
  // 任せ、ここでは「コピー後に選択モードを終了する」（handleBulkCopyClick）と全く同じパターンで
  // selectionModeActiveをfalseへ戻すだけにする（13章：新しいモーダル状態管理システムは作らない。
  // 確認モーダル自体はApp側のpendingBulkDeleteIdsを見てこのコンポーネント内で描画するため、
  // 確認後の選択モード終了をこの1箇所へ集約できる）。
  const handleConfirmBulkDeleteClick = useCallback(() => {
    if (onConfirmBulkDelete) onConfirmBulkDelete();
    setSelectionModeActive(false);
  }, [onConfirmBulkDelete]);

  // 6章：通常モードは従来通り「goToSlide→モーダルを閉じる」。出力用選択モード・
  // コピー選択モード（どちらもisMultiSelectMode）は「選択ON/OFFを切り替えるだけ」で、
  // goToSlideもしない・モーダルも閉じない。
  const handleCardClick = (index) => {
    if (isMultiSelectMode) {
      const slide = slides[index];
      const toggle = isExportMode ? onToggleSlideSelection : onToggleCopySlideSelection;
      if (slide && toggle) toggle(slide.id);
      return;
    }
    if (isTransitionActive) return;
    onSelectSlide(index);
    onClose();
  };

  // 構成一覧v2・第1段階：構成カードのドラッグ＆ドロップ並べ替え。
  // CompositionBar（下部操作バー）の既存ドラッグ＆ドロップ実装と全く同じ考え方・同じ
  // 外部ライブラリ不使用（HTML5 Drag and Drop APIのみ）で、ここでも「ドラッグ中かどうか」
  // 「どこへ挿入されようとしているか」という一時的なUI stateだけを持つ。実際のslides配列の
  // 書き換えは行わず、ドロップ確定時に既存のmoveSlide（＝onReorderSlide）を1回呼び出すだけに
  // することで、選択中インデックスの追従・transitionCounts/transitionPathsの再計算・
  // Undo履歴への積み方（1回のcommit＝1件の履歴）は、既存のmoveSlideのロジックがそのまま
  // 適用される（新しい並べ替えロジックを作らない）。
  // CompositionBarは横一列（flex row）でX座標を見て前後判定するが、ここはレスポンシブな
  // グリッド（複数列・複数行）のため、Y座標（カード上半分/下半分）で前後判定する（この
  // 判定ロジック自体はv2.1でも一切変更していない）。挿入位置の見せ方だけをv2.1で、
  // グリッド全幅の細い横線から「カード1枚分の挿入プレースホルダー」（SlideListDropPlaceholderCard）
  // へ変更した。判定・確定ロジックの骨格はCompositionBarと同一のまま。
  const isReorderable = !isMultiSelectMode && !!onReorderSlide;
  const [dragIndex, setDragIndex] = useState(null);
  const [dropBeforeIndex, setDropBeforeIndex] = useState(null);
  const clearDragState = useCallback(() => {
    setDragIndex(null);
    setDropBeforeIndex(null);
  }, []);
  const handleCardDragStart = useCallback(
    (e, index) => {
      if (!isReorderable || isTransitionActive) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(index)); // 一部ブラウザで必要（実判定には使わない）
      setDragIndex(index);
    },
    [isReorderable, isTransitionActive]
  );
  const handleGridDragOver = useCallback(
    (e) => {
      if (!isReorderable || isTransitionActive || dragIndex == null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const cardEl = e.target && e.target.closest ? e.target.closest("[data-slide-index]") : null;
      if (cardEl) {
        const idx = parseInt(cardEl.dataset.slideIndex, 10);
        const rect = cardEl.getBoundingClientRect();
        const insertBefore = e.clientY < rect.top + rect.height / 2;
        setDropBeforeIndex(insertBefore ? idx : idx + 1);
      }
    },
    [isReorderable, isTransitionActive, dragIndex]
  );
  const handleGridDrop = useCallback(
    (e) => {
      if (!isReorderable || isTransitionActive) return;
      e.preventDefault();
      const from = dragIndex;
      const before = dropBeforeIndex;
      clearDragState();
      if (from == null || before == null) return;
      // 「削除してから挿入する」moveSlideの仕様に合わせて、削除後のインデックスへ変換する
      // （CompositionBarのhandleContainerDropと全く同じ変換式）。
      let target = before;
      if (target > from) target -= 1;
      if (target !== from) onReorderSlide(from, target);
    },
    [isReorderable, isTransitionActive, dragIndex, dropBeforeIndex, clearDragState, onReorderSlide]
  );

  // 11章：モーダルを開いた瞬間だけ、現在構成のカードが見える位置まで自動スクロールする。
  // SlideListModal自体がslideListOpen/exportSlidePickerOpenの切り替えで毎回マウントし直される
  // （App側で条件レンダリングになっているため）ので、依存配列を空にしたuseEffectは
  // 「モーダルを開いた瞬間に1回だけ」実行され、以後はユーザーの手動スクロールを一切妨げない。
  // UI Stability & Bottom Navigation v1・PART A-2：以前はここもcurrentCardRef.scrollIntoView()を
  // 使っていたが、CompositionBar側の調査で判明した「scrollIntoView()はスクロール可能な
  // 祖先すべてを対象にしてしまう」という同じ性質のリスクを避けるため、対象を
  // 「このモーダル自身の縦スクロール領域（listViewportRef）」だけに限定した手動計算へ
  // 置き換えた。position:fixedの全画面オーバーレイの中で完結する処理のため実害は
  // 起きにくいが、PART A-2「スクロールが必要な場合もcontainer.scrollTop等で対象コンテナ
  // 自身だけを動かす」の方針に合わせ、念のため同じ考え方に統一する。
  const currentCardRef = useRef(null);
  const listViewportRef = useRef(null);
  useEffect(() => {
    const card = currentCardRef.current;
    const viewport = listViewportRef.current;
    if (!card || !viewport) return;
    if (typeof card.offsetTop === "number" && typeof viewport.clientHeight === "number") {
      // block:"center"相当：カードの中心がビューポートの中心に来るscrollTopを計算する。
      const targetTop = card.offsetTop - viewport.clientHeight / 2 + card.offsetHeight / 2;
      viewport.scrollTop = Math.max(0, targetTop);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        // Export Center v1：出力用選択モードはExportCenterModal（zIndex 225）の「上」に
        // 開く必要があるため、通常モード（単独で開く一覧）より高いzIndexを使う。
        zIndex: isExportMode ? 230 : 200,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: THEME.panelBg,
          border: `1px solid ${THEME.border}`,
          borderRadius: 14,
          padding: 20,
          width: "85vw",
          maxWidth: 1200,
          height: "80vh",
          maxHeight: 820,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2" style={{ flexShrink: 0 }}>
          <h2 style={{ color: THEME.text }} className="text-sm font-bold">
            {isExportMode ? "構成を選択（出力用）" : isCopySelectionActive ? "構成を選択" : "構成一覧"}
            <span style={{ color: THEME.textDim, fontWeight: 400, marginLeft: 8 }} className="text-xs">
              {isMultiSelectMode ? (
                (() => {
                  // 複数構成一括コピー v1・STEP1：copy-selection中はselectedCopySlideIds、
                  // export-selection中はselectedSlideIds、と参照元だけ切り替える（表示ロジック自体は共通）。
                  const activeIds = isExportMode ? selectedSlideIds : selectedCopySlideIds;
                  const count = (activeIds && activeIds.length) || 0;
                  return (
                    <span style={{ color: count > 0 ? THEME.accent : THEME.textDim, fontWeight: 700 }}>
                      {count}件選択中
                    </span>
                  );
                })()
              ) : (
                `全${slides.length}構成`
              )}
            </span>
          </h2>
          <div className="flex items-center gap-2">
            {/* 複数構成一括コピー v1・STEP1：normalモード・選択モードOFFの時だけ「選択」ボタンを出す。
                export-selectionモード中はこのボタン自体が無関係（Export Center専用の別入口から開くため）。 */}
            {mode === "normal" && !isCopySelectionActive && (
              <button
                type="button"
                onClick={enterCopySelectionMode}
                style={{ background: THEME.panelBg2, border: `1px solid ${THEME.border}`, color: THEME.text }}
                className="px-2.5 py-1 rounded-lg text-xs font-bold"
              >
                選択
              </button>
            )}
            {/* Export Center v1・9章：すべて選択／選択解除。検索・フィルターは今回不要。
                複数構成一括コピー v1・STEP1：copy-selection中も同じ「すべて選択／選択解除」を
                共有し、対象だけonSelectAllCopySlides/onClearCopySlideSelectionへ切り替える。 */}
            {isMultiSelectMode && (
              <>
                <button
                  type="button"
                  onClick={isExportMode ? onSelectAllSlides : onSelectAllCopySlides}
                  style={{ background: THEME.panelBg2, border: `1px solid ${THEME.border}`, color: THEME.text }}
                  className="px-2.5 py-1 rounded-lg text-xs font-bold"
                >
                  すべて選択
                </button>
                <button
                  type="button"
                  onClick={isExportMode ? onClearSlideSelection : onClearCopySlideSelection}
                  style={{ background: THEME.panelBg2, border: `1px solid ${THEME.border}`, color: THEME.text }}
                  className="px-2.5 py-1 rounded-lg text-xs font-bold"
                >
                  選択解除
                </button>
              </>
            )}
            {/* 複数構成一括コピー v1・STEP1：copy-selection専用の「コピー」「完了」。
                「コピー」実行後は選択状態クリア・選択モード終了までをこのボタン内で完結させる
                （二段階操作にしない＝確定仕様）。 */}
            {isCopySelectionActive && (
              <>
                <button
                  type="button"
                  onClick={handleBulkCopyClick}
                  disabled={!selectedCopySlideIds || selectedCopySlideIds.length === 0}
                  style={
                    selectedCopySlideIds && selectedCopySlideIds.length > 0
                      ? { background: THEME.accent, border: `1px solid ${THEME.accent}`, color: "#141318" }
                      : { background: THEME.panelBg2, border: `1px solid ${THEME.borderSoft}`, color: THEME.textDim }
                  }
                  className="px-2.5 py-1 rounded-lg text-xs font-bold"
                >
                  コピー
                </button>
                {/* 一括削除 v1・3・22章：コピーとは明確に見た目を分ける（THEME.danger）。
                    削除不可時はTHEME.textDim・cursor:not-allowedにし、titleで理由（未選択／
                    最低1構成ルール／再生中）を分かるようにする。 */}
                <button
                  type="button"
                  onClick={onRequestBulkDelete}
                  disabled={!canBulkDelete}
                  title={bulkDeleteDisabledTitle}
                  style={
                    canBulkDelete
                      ? { background: THEME.danger, border: `1px solid ${THEME.danger}`, color: "#141318" }
                      : { background: THEME.panelBg2, border: `1px solid ${THEME.borderSoft}`, color: THEME.textDim, cursor: "not-allowed" }
                  }
                  className="px-2.5 py-1 rounded-lg text-xs font-bold"
                >
                  削除
                </button>
                <button
                  type="button"
                  onClick={exitCopySelectionMode}
                  style={{ background: THEME.panelBg2, border: `1px solid ${THEME.border}`, color: THEME.text }}
                  className="px-2.5 py-1 rounded-lg text-xs font-bold"
                >
                  完了
                </button>
              </>
            )}
            <button onClick={onClose} style={{ color: THEME.textDim }} className="text-sm font-bold" aria-label="閉じる">
              ✕
            </button>
          </div>
        </div>
        {/* 一括削除 v1・11章：削除確認モーダル。App側のpendingBulkDeleteIds（snapshot）を
            見て、このコンポーネント内で描画する（Export Center等とは別のオーバーレイとして、
            単体削除のConfirmDeleteSlideModalと同じスタックの仕方＝z-index 210で背面をブロック）。
            ここで描画する理由：確認後にselectionModeActive（このコンポーネントのローカルstate）を
            終了させる必要があり、App側から直接このローカルstateへは触れられないため（13章）。 */}
        {pendingBulkDeleteIds && (
          <ConfirmDeleteSlidesModal
            count={pendingBulkDeleteIds.length}
            onConfirm={handleConfirmBulkDeleteClick}
            onCancel={onCancelBulkDelete}
          />
        )}
        {!isMultiSelectMode && isTransitionActive && (
          <p style={{ color: THEME.textDim, flexShrink: 0 }} className="text-xs mb-2">
            再生中・同期再生中は構成を切り替えられません。「編集に戻る」の後にご利用ください。
          </p>
        )}
        {/* 構成一覧v2・第2段階①・3章：コピー中であることを分かるようにする、控えめな状態表示。
            大きなツールバーは作らず、既存のタイトル行のすぐ下に1行だけ追加する。コピー元が
            見つからない場合（削除された場合）は、App側のuseEffectでcopiedSlideId自体が
            自動的にnullへ戻るため、ここでは「コピー中かつ対象が見つかる場合だけ」表示する。
            複数構成一括コピー v1：copy-selection中はこの単体コピー用バナーは表示しない
            （選択操作と紛れないようにするため）。 */}
        {!isMultiSelectMode &&
          copiedSlideId &&
          (() => {
            const copiedIndex = slides.findIndex((s) => s.id === copiedSlideId);
            if (copiedIndex === -1) return null;
            return (
              <div
                className="flex items-center justify-between gap-2 mb-2"
                style={{
                  flexShrink: 0,
                  background: `${THEME.accent}14`,
                  border: `1px solid ${THEME.accent}`,
                  borderRadius: 8,
                  padding: "4px 10px",
                }}
              >
                <span style={{ color: THEME.accent }} className="text-xs font-bold">
                  コピー中：構成{copiedIndex + 1} {slides[copiedIndex].name}
                </span>
                <button
                  type="button"
                  onClick={onClearCopiedSlide}
                  style={{ color: THEME.textDim, background: "transparent", border: "none" }}
                  className="text-xs font-bold hover:opacity-80"
                >
                  解除
                </button>
              </div>
            );
          })()}
        {isExportMode && (
          <p style={{ color: THEME.textDim, flexShrink: 0 }} className="text-xs mb-2">
            カードをクリックして出力する構成を選択／解除できます。選択順に関わらず、出力は構成の並び順で行われます。
          </p>
        )}
        {isCopySelectionActive && (
          <p style={{ color: THEME.textDim, flexShrink: 0 }} className="text-xs mb-2">
            カードをクリックして構成を選択／解除できます。選択した構成はコピーまたは削除できます。元の構成で直接隣り合っていた選択構成同士は、コピー時に移動時間・移動経路も一緒にコピーされます。
          </p>
        )}
        {/* ListViewport：縦スクロールを担当する層。flex:1で残り高さいっぱいまで広がるが、
            min-height:0を明示することで「中のGridの自然なコンテンツ高さがこの残り高さを
            超えてもこの層自体は縮まず、overflow-y:autoで縦スクロールする」という、
            意図した挙動になる（2・3・7章）。列数はauto-fillで画面幅に応じて自然に
            4列→3列→2列→1列と変化するレスポンシブ設計にし、横スクロール前提にはしない
            （5・8・13章）。 */}
        <div ref={listViewportRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingRight: 4 }}>
          {/* Grid：align-content:startとheight:max-contentにより、行（＝カード）の高さは
              常にカード自身の自然なコンテンツ高さ（FormationThumbnailのaspect-ratio 4:3＋
              番号・構成名の行）だけで決まる。構成数が増えて行数が増えても、Grid自身の
              高さがそれに合わせて伸びるだけで、既存の各行を圧縮することは一切ない
              （1・3・4・6章：これが今回の中心的な修正）。 */}
          <div
            onDragOver={handleGridDragOver}
            onDrop={handleGridDrop}
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
              gridAutoRows: "max-content",
              alignContent: "start",
              alignItems: "start",
              height: "max-content",
              gap: 14,
            }}
          >
            {slides.map((slide, index) => {
              const isCurrent = index === currentSlideIndex;
              const isSelectedForExport = isExportMode && !!selectedSlideIds && selectedSlideIds.includes(slide.id);
              const isSelectedForCopy = isCopySelectionActive && !!selectedCopySlideIds && selectedCopySlideIds.includes(slide.id);
              const isSelectedForMultiMode = isSelectedForExport || isSelectedForCopy;
              // Export Center v1・8章：出力用選択モードでは「選択されているか」で枠色・背景を
              // 決め、通常モードの「現在編集中の構成か」というhighlight基準とは切り替える。
              // 複数構成一括コピー v1：copy-selectionモードも同じ考え方（選択されているかで判定）。
              const highlighted = isMultiSelectMode ? isSelectedForMultiMode : isCurrent;
              const cardDisabled = !isExportMode && isTransitionActive;
              const hasManualAnchor = !!getMusicAnchor(slide);
              // PART A・2章：既存のresolveSlideMusicPosition()をそのまま再利用する（手動Anchor・
              // Auto Chainどちらも同じ経路で解決される）。位置計算ロジック自体はここには一切無い。
              const resolvedMusicPosition = resolveSlideMusicPosition(slides, index, musicSections, transitionCounts);
              const musicLabel = formatFormationListMusicLabel(resolvedMusicPosition, musicSections);
              // 構成一覧v2・第1段階：ドラッグ中は元の位置のカードを薄く表示する（CompositionBarの
              // SlideCardと同じ考え方）。ドラッグ・「…」管理メニューはnormalモードだけで有効。
              const isDraggingThis = isReorderable && dragIndex === index;
              // 構成一覧v2・第2段階②・PART A/C：copiedSlideId／recentlyPastedSlideIdという
              // 「idの一致」だけからこの2つのフラグを導出する。slideオブジェクト自体には
              // isCopiedのような新しい属性を一切追加しない（work schemaは変更しない）。
              // export-selection・copy-selectionのどちらのモードでも、単体コピーの
              // バッジ・強調とは紛れないよう常にfalseにする。
              const isCopySource = !isMultiSelectMode && !!copiedSlideId && copiedSlideId === slide.id;
              const isRecentlyPasted = !isMultiSelectMode && !!recentlyPastedSlideId && recentlyPastedSlideId === slide.id;
              return (
                <React.Fragment key={slide.id}>
                  {/* 構成一覧v2・第1段階：挿入位置インジケーター（グリッド全幅の横線）。
                      CompositionBarのDropInsertionIndicator（縦線・横一列用）と役割は同じだが、
                      複数列に折り返すグリッドのため、ここでは全幅の横線で「この行の直前へ挿入」
                      を示す形にしている（判定・確定ロジックの骨格は完全に同一）。 */}
                  {isReorderable && dropBeforeIndex === index && dragIndex !== null && <SlideListDropPlaceholderCard />}
                  <div
                    ref={isCurrent ? currentCardRef : null}
                    data-slide-index={index}
                    role="button"
                    tabIndex={cardDisabled ? -1 : 0}
                    draggable={isReorderable && !isTransitionActive}
                    onDragStart={isReorderable ? (e) => handleCardDragStart(e, index) : undefined}
                    onDragEnd={isReorderable ? clearDragState : undefined}
                    onClick={() => {
                      if (cardDisabled) return;
                      handleCardClick(index);
                    }}
                    onKeyDown={(e) => {
                      if (cardDisabled) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleCardClick(index);
                      }
                    }}
                    title={
                      isMultiSelectMode
                        ? `構成${index + 1}：${slide.name}を${isSelectedForMultiMode ? "選択解除" : "選択"}`
                        : isTransitionActive
                        ? "再生中は構成を切り替えられません"
                        : `構成${index + 1}：${slide.name}へ移動（ドラッグで並べ替え）`
                    }
                    style={{
                      textAlign: "left",
                      background: highlighted ? THEME.panelBg2 : "transparent",
                      border: `2px solid ${highlighted ? THEME.accent : THEME.border}`,
                      borderRadius: 10,
                      padding: 0,
                      overflow: "hidden",
                      cursor: cardDisabled ? "default" : isReorderable ? "grab" : "pointer",
                      opacity: isDraggingThis ? 0.4 : cardDisabled && !isCurrent ? 0.55 : 1,
                      display: "flex",
                      flexDirection: "column",
                      position: "relative",
                      // Gridアイテムとしての縮小・引き伸ばしを禁止し、常に自身の自然な高さを保つ
                      // （3章：flex-shrinkはgridアイテムには効かないため、align-self:startで代替する）。
                      alignSelf: "start",
                      width: "100%",
                      // 構成一覧v2・第2段階②：既存のborder/background（現在・選択・drag状態の判定）は
                      // 一切変更せず、box-shadowを「追加のリング」として上乗せするだけにする。
                      // これにより、current/selected/dragの既存デザインと混同しない、独立した
                      // 視覚レイヤーとしてコピー中・貼り付け直後の状態を表現できる（PART A）。
                      // 貼り付け直後のglowは、setTimeoutでrecentlyPastedSlideIdがnullへ戻る瞬間に
                      // box-shadowがふっと消えるよう、transitionで滑らかにフェードアウトさせる
                      // （PART C：「約1秒で自然に消える」）。
                      boxShadow: isRecentlyPasted
                        ? `0 0 0 3px ${THEME.accent}, 0 0 14px 3px ${THEME.accent}99`
                        : isCopySource
                        ? `inset 0 0 0 2px ${THEME.accent}cc`
                        : "none",
                      transition: "box-shadow 0.4s ease-out",
                    }}
                  >
                    {/* サムネイル：完全に読み取り専用（FormationThumbnail自体もpointerEvents:none）。
                        4:3のaspect-ratioはカード幅（＝列数とモーダル幅で決まる）だけに連動し、
                        構成数（行数）には一切影響されない。 */}
                    <div style={{ width: "100%", aspectRatio: "4 / 3", background: THEME.bg, position: "relative" }}>
                      <FormationThumbnail stage={stage} zones={zones} performers={performers} placements={slide.placements} />
                      {/* 構成一覧v2・第2段階②・PART A：コピー元カードだけに出す、控えめな
                          「コピー中」バッジ。「現在」／✓バッジ（右上）・「…」メニュー（左上）とは
                          別の角（左下）に置き、既存バッジ類と重ならないようにする。 */}
                      {isCopySource && (
                        <span
                          style={{
                            position: "absolute",
                            bottom: 4,
                            left: 4,
                            background: THEME.panelBg,
                            color: THEME.accent,
                            border: `1px solid ${THEME.accent}`,
                            borderRadius: 999,
                            padding: "1px 6px",
                            fontSize: 10,
                            fontWeight: 700,
                          }}
                        >
                          コピー中
                        </span>
                      )}
                      {/* Export Center v1・8章：出力用選択モードでは「現在」バッジの代わりに、
                          選択されている構成の右上へ✓バッジを表示する（常時大きなチェックボックスは
                          表示しない方針＝カードそのものが選択UIを兼ねる）。
                          複数構成一括コピー v1：copy-selectionモードも同じ✓バッジを共有する。 */}
                      {isMultiSelectMode
                        ? isSelectedForMultiMode && (
                            <span
                              style={{
                                position: "absolute",
                                top: 4,
                                right: 4,
                                width: 20,
                                height: 20,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                background: THEME.accent,
                                color: "#141318",
                                borderRadius: 999,
                                fontSize: 12,
                                fontWeight: 700,
                              }}
                            >
                              ✓
                            </span>
                          )
                        : isCurrent && (
                            <span
                              style={{
                                position: "absolute",
                                top: 4,
                                right: 4,
                                background: THEME.accent,
                                color: "#141318",
                                borderRadius: 999,
                                padding: "1px 6px",
                                fontSize: 10,
                                fontWeight: 700,
                              }}
                            >
                              現在
                            </span>
                          )}
                      {/* 構成一覧v2・第2段階①：「…」管理メニュー（複製・コピー・ここに貼り付け・削除）。
                          normalモードかつ選択モードOFFの時だけ、目立ちすぎない小さなボタンとして
                          左上に置く（右上は「現在」バッジと共存させないため、あえて反対側に配置）。
                          複数構成一括コピー v1・STEP1：copy-selectionモード中は非表示にする
                          （export-selectionと同じ考え方＝複数選択中に単体操作が混ざらないようにする）。 */}
                      {!isMultiSelectMode && (
                        <SlideCardMenuButton
                          disabled={isTransitionActive}
                          canDelete={!!canDeleteSlide}
                          canPaste={!!copiedSlideId || !!hasBulkClipboard}
                          onDuplicate={() => onDuplicateSlide && onDuplicateSlide(index)}
                          onCopy={() => onCopySlide && onCopySlide(index)}
                          onPasteAfter={() => onPasteSlideAfter && onPasteSlideAfter(index)}
                          onDelete={() => onRequestDeleteSlide && onRequestDeleteSlide(index)}
                        />
                      )}
                    </div>
                    {/* footer：PART A・1章・7章によりサムネイルサイズはそのままに2段構成へ拡張。
                        1段目（番号＋構成名＋手動Anchorバッジ）は既存のまま変更しない。 */}
                    <div style={{ padding: "6px 8px 2px", display: "flex", alignItems: "center", gap: 6 }}>
                      <span
                        style={{
                          color: highlighted ? THEME.accent : THEME.textDim,
                          fontWeight: 700,
                          fontVariantNumeric: "tabular-nums",
                          flexShrink: 0,
                        }}
                        className="text-xs"
                      >
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span
                        style={{
                          color: THEME.text,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          flex: 1,
                        }}
                        className="text-xs font-bold"
                        title={slide.name}
                      >
                        {slide.name}
                      </span>
                      {/* 22章：手動Music Anchorがある構成だけ、控えめな♫アイコンを添える（詳細情報は出さない） */}
                      {hasManualAnchor && (
                        <span style={{ color: THEME.textDim, flexShrink: 0 }} className="text-xs" title="この構成には手動Music Anchorが設定されています">
                          ♫
                        </span>
                      )}
                    </div>
                    {/* 2段目（新規）：PART A。resolveSlideMusicPosition()の結果をformatFormationListMusicLabel()で
                        整形しただけの表示専用の行（3章：手動はアクセント色＋太字、自動は控えめな色、
                        未解決は「♫ 未設定」を暗めに表示。クラッタを避けるため[手動]/[自動]の
                        文字ラベルまでは付けず、色の強弱だけで区別する簡易版を採用した）。 */}
                    <div style={{ padding: "0 8px 6px" }}>
                      <span
                        style={{
                          color: musicLabel.isUnset ? THEME.textDim : musicLabel.isManual ? THEME.accent : THEME.textDim,
                          fontWeight: musicLabel.isManual ? 700 : 400,
                          opacity: musicLabel.isUnset ? 0.6 : 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          display: "block",
                        }}
                        className="text-[10px]"
                        title={
                          musicLabel.isUnset
                            ? "音楽位置が未設定です"
                            : musicLabel.isManual
                            ? "手動Music Anchorによる音楽位置です"
                            : "Auto Chainによる自動計算の音楽位置です"
                        }
                      >
                        {musicLabel.text}
                      </span>
                    </div>
                  </div>
                </React.Fragment>
              );
            })}
            {/* 構成一覧v2.1：末尾への挿入プレースホルダー（表示中の最後のカードの直後）。
                CompositionBarのB-2と同じ考え方だが、v2.1でカード形状のプレースホルダーへ変更した。 */}
            {isReorderable && dropBeforeIndex === slides.length && dragIndex !== null && <SlideListDropPlaceholderCard />}
          </div>
        </div>
      </div>
    </div>
  );
}

// 構成一覧v2.1：ドラッグ中の挿入位置を「カード1枚分の挿入プレースホルダー」として示す。
// v2第1段階のSlideListDropInsertionIndicator（グリッド全幅の細い横線）を置き換えたもので、
// 挿入index計算（dragIndex・dropBeforeIndex・handleGridDragOver等）や実際の並べ替え
// （moveSlide呼び出し）には一切手を加えていない。変わったのは「同じgrid cellを、線ではなく
// カードと同じ見た目の箱で占有する」という表示方法だけ（4章：挿入位置＝実際にdropされる
// index、という対応関係は従来通り厳密に一致している）。
// 通常カードと全く同じDOM構造（サムネイル領域＋footer2段）の比率で組み立てることで、
// 列数に応じてカード幅が変わっても、プレースホルダーの高さが実カードの自然な高さへ
// 追従し、grid全体のレイアウトが崩れない（layout shiftを起こさない）ようにしてある。
function SlideListDropPlaceholderCard() {
  return (
    <div
      aria-hidden="true"
      style={{
        alignSelf: "start",
        width: "100%",
        borderRadius: 10,
        border: `2px dashed ${THEME.accent}`,
        background: `${THEME.accent}1f`, // アクセントカラーの薄い塗り（8桁hexで透明度指定・強く目立たせない）
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* サムネイル相当の領域：実カードと同じ4:3比率にすることで高さが自然に揃う */}
      <div style={{ width: "100%", aspectRatio: "4 / 3", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ color: THEME.accent, opacity: 0.9 }} className="text-xs font-bold">
          ここに移動
        </span>
      </div>
      {/* footer相当の領域：実カードのfooter2段（padding「6px 8px 2px」「0 8px 6px」）と
          同じ高さになるよう、見えないテキストで高さだけ揃える（layout shift防止）。 */}
      <div style={{ padding: "6px 8px 2px", visibility: "hidden" }} className="text-xs" aria-hidden="true">
        {"\u00A0"}
      </div>
      <div style={{ padding: "0 8px 6px", visibility: "hidden" }} className="text-[10px]" aria-hidden="true">
        {"\u00A0"}
      </div>
    </div>
  );
}

// 構成一覧v2・第1段階：各カード左上に置く、目立ちすぎない「…」管理メニュー（複製・削除）。
// カード自体のクリック（goToSlide）・ドラッグ（並べ替え）を妨げないよう、このメニュー領域は
// 独立したポインタイベントとして扱い、親カードへは伝播させない（draggable=falseも明示し、
// メニューボタンからドラッグが誤って始まらないようにする）。
// 削除は、ここでApp側のonRequestDeleteSlideを呼ぶだけに留め、実際の削除確認・実行は
// 既存のConfirmDeleteSlideModal／deleteSlideAtへ委譲する（誤操作防止の2段階確認を維持）。
// 構成一覧v2・第2段階①：「コピー」（work変更なし・Undo履歴を作らない）と「ここに貼り付け」
// （copiedSlideIdがある場合だけ表示。1回のcommit＝1件のUndo履歴）を、複製と削除の間へ追加した。
function SlideCardMenuButton({ disabled, canDelete, canPaste, onDuplicate, onCopy, onPasteAfter, onDelete }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      draggable={false}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{ position: "absolute", top: 4, left: 4, zIndex: 2 }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-label="構成メニュー（複製・コピー・貼り付け・削除）"
        title="構成メニュー（複製・コピー・貼り付け・削除）"
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          background: "rgba(20,19,24,0.78)",
          color: THEME.text,
          border: `1px solid ${THEME.border}`,
          fontSize: 13,
          lineHeight: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.4 : 1,
        }}
      >
        ⋯
      </button>
      {open && (
        <>
          {/* 外側クリックで閉じるための透明オーバーレイ（ProjectSwitcher等と同じ既存パターン） */}
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 3 }} />
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              left: 0,
              zIndex: 4,
              background: THEME.panelBg,
              border: `1px solid ${THEME.border}`,
              borderRadius: 8,
              minWidth: 140,
              boxShadow: "0 6px 18px rgba(0,0,0,0.4)",
              overflow: "hidden",
            }}
          >
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onDuplicate();
              }}
              style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", background: "transparent", border: "none", color: THEME.text }}
              className="text-xs hover:opacity-80"
            >
              複製
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onCopy();
              }}
              style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", background: "transparent", border: "none", color: THEME.text }}
              className="text-xs hover:opacity-80"
            >
              コピー
            </button>
            {canPaste && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onPasteAfter();
                }}
                style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", background: "transparent", border: "none", color: THEME.accent }}
                className="text-xs font-bold hover:opacity-80"
              >
                この後に貼り付け
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                if (canDelete) onDelete();
              }}
              disabled={!canDelete}
              title={!canDelete ? "構成が1つしかないため削除できません" : undefined}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "8px 10px",
                background: "transparent",
                border: "none",
                color: canDelete ? THEME.danger : THEME.textDim,
                cursor: canDelete ? "pointer" : "not-allowed",
              }}
              className="text-xs hover:opacity-80"
            >
              削除
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// Export Center v1：出力の入口モーダル
// ------------------------------------------------------------------
// 「どの構成を出力するか」（targetMode・selectedCount・onOpenSlidePicker）と
// 「どう描画するか」（表示オプション・ビュー・将来の「形式」）を分離したUIコンポーネント。
// このコンポーネント自身はwork/slidesを直接参照せず、App側から渡された値・コールバックだけで
// 動作する（21章：Undo/Redo対象外・work非依存を徹底するため）。実際のPNG生成は
// onConfirmExport（App側のhandleExportCenterConfirm）に完全委譲し、ここでは行わない。
function ExportCenterModal({
  onClose,
  targetMode,
  onTargetModeChange,
  onOpenSlidePicker,
  selectedCount,
  totalSlideCount,
  currentSlideNumber,
  showWaitingAreas,
  onShowWaitingAreasChange,
  showTrajectory,
  onShowTrajectoryChange,
  trajectoryMode,
  onTrajectoryModeChange,
  showPerformerNames,
  onShowPerformerNamesChange,
  // Export音楽位置・音源内時間 v1：「音源内時間を表示」チェックボックス用。他の表示オプション
  // （showWaitingAreas等）と全く同じパターン（App側でstateを持ち、propsで受け渡すだけ）。
  showMusicTime,
  onShowMusicTimeChange,
  displayScale,
  onDisplayScaleChange,
  viewChoice,
  onViewChoiceChange,
  currentViewLabel,
  format,
  onFormatChange,
  busy,
  error,
  onDismissError,
  onConfirmExport,
  confirmDisabled,
  confirmLabel,
}) {
  const radioRowStyle = { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" };
  const sectionTitleStyle = { color: THEME.textDim, fontWeight: 700, letterSpacing: "0.02em" };

  return (
    <div
      onClick={busy ? undefined : onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 225,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: THEME.panelBg,
          border: `1px solid ${THEME.border}`,
          borderRadius: 14,
          padding: 20,
          width: "92vw",
          maxWidth: 420,
          maxHeight: "88vh",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div className="flex items-center justify-between" style={{ flexShrink: 0 }}>
          <h2 style={{ color: THEME.text }} className="text-sm font-bold">
            出力
          </h2>
          <button
            onClick={onClose}
            disabled={busy}
            style={{ color: THEME.textDim, opacity: busy ? 0.5 : 1 }}
            className="text-sm font-bold"
            aria-label="閉じる"
          >
            ✕
          </button>
        </div>

        {/* 出力する構成：現在の構成 / 構成を選択 / すべての構成（2・3・4・5章） */}
        <div className="flex flex-col gap-2">
          <span className="text-xs" style={sectionTitleStyle}>
            出力する構成
          </span>
          <label style={radioRowStyle} className="text-sm" title={`現在表示中の構成${currentSlideNumber}だけを出力します`}>
            <input type="radio" name="export-target-mode" checked={targetMode === "current"} onChange={() => onTargetModeChange("current")} />
            <span style={{ color: THEME.text }}>現在の構成（構成{currentSlideNumber}）</span>
          </label>
          <label style={radioRowStyle} className="text-sm">
            <input
              type="radio"
              name="export-target-mode"
              checked={targetMode === "selection"}
              onChange={() => {
                onTargetModeChange("selection");
                onOpenSlidePicker();
              }}
            />
            <span style={{ color: THEME.text }}>構成を選択</span>
            {targetMode === "selection" && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  onOpenSlidePicker();
                }}
                style={{ color: THEME.accent, background: "transparent", border: "none", padding: 0 }}
                className="text-xs underline decoration-dotted"
              >
                {selectedCount}件選択中（変更する）
              </button>
            )}
          </label>
          <label style={radioRowStyle} className="text-sm" title={`全${totalSlideCount}構成をスライド順に出力します`}>
            <input type="radio" name="export-target-mode" checked={targetMode === "all"} onChange={() => onTargetModeChange("all")} />
            <span style={{ color: THEME.text }}>すべての構成（全{totalSlideCount}構成）</span>
          </label>
        </div>

        {/* 表示オプション：待機エリア（既存のexportShowWaitingAreasをそのまま再利用＝13章）・
            移動軌跡（Export Center専用state・trajectoryMode「次に／前に」も含む＝13・15章） */}
        <div className="flex flex-col gap-2">
          <span className="text-xs" style={sectionTitleStyle}>
            表示オプション
          </span>
          <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: THEME.text }}>
            <input type="checkbox" checked={showWaitingAreas} onChange={(e) => onShowWaitingAreasChange(e.target.checked)} />
            待機エリア
          </label>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: THEME.text }}>
              <input type="checkbox" checked={showTrajectory} onChange={(e) => onShowTrajectoryChange(e.target.checked)} />
              移動軌跡
            </label>
            {showTrajectory && (
              <div
                className="flex items-center gap-0.5"
                style={{ background: THEME.panelBg2, border: `1px solid ${THEME.border}`, borderRadius: 8, padding: 2 }}
                role="group"
                aria-label="移動軌跡の参照方向"
              >
                <button
                  type="button"
                  onClick={() => onTrajectoryModeChange("next")}
                  style={{
                    background: trajectoryMode === "next" ? THEME.accent : "transparent",
                    color: trajectoryMode === "next" ? "#141318" : THEME.textDim,
                    border: "none",
                    borderRadius: 6,
                  }}
                  className="px-2 py-0.5 text-xs font-bold"
                >
                  次に
                </button>
                <button
                  type="button"
                  onClick={() => onTrajectoryModeChange("previous")}
                  style={{
                    background: trajectoryMode === "previous" ? THEME.accent : "transparent",
                    color: trajectoryMode === "previous" ? "#141318" : THEME.textDim,
                    border: "none",
                    borderRadius: 6,
                  }}
                  className="px-2 py-0.5 text-xs font-bold"
                >
                  前に
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 出演者名 v1・10章：待機エリア・移動軌跡と同じ「表示オプション」欄に追加する。
            平面図出力の場合だけ実際に反映され（renderTopFormationExport）、俯瞰客席ビュー
            出力では常に無視される（14章：この設定に関わらず名前は表示されない）。 */}
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: THEME.text }}>
            <input type="checkbox" checked={showPerformerNames} onChange={(e) => onShowPerformerNamesChange(e.target.checked)} />
            出演者名（平面図のみ反映されます）
          </label>
        </div>

        {/* Export音楽位置・音源内時間 v1：他の表示オプション（待機エリア・出演者名）と同じ並びに
            配置する。平面図・俯瞰客席ビューどちらの出力でも、Music Position見出しの表示文字列
            （model.musicPosition.text）へ既に組み込まれているため、ここではON/OFFの入力だけを
            担い、描画側（renderTopFormationExport／renderAudienceFormationExport／
            drawFormationExportHeader）には一切手を加えていない。 */}
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: THEME.text }}>
            <input type="checkbox" checked={showMusicTime} onChange={(e) => onShowMusicTimeChange(e.target.checked)} />
            音源内時間を表示
          </label>
        </div>

        {/* Export表示倍率 v1・PART C・O：auto-fit（100%）を基準にした構図倍率。
            編集画面のzoom UI（ZoomToolbar）に近い操作感（−／数値／＋）を踏襲しつつ、
            state自体は編集画面のviewState.zoomとは完全に独立させている。
            90%〜110%を5%刻みでクランプし、UIには常に整数%で表示する（内部値は0.9〜1.1の
            小数だが、表示は105%のように丸める）。 */}
        <div className="flex flex-col gap-2">
          <span className="text-xs" style={sectionTitleStyle}>
            出力表示倍率
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                onDisplayScaleChange(Math.max(EXPORT_DISPLAY_SCALE_MIN, Math.round((displayScale - EXPORT_DISPLAY_SCALE_STEP) * 100) / 100))
              }
              disabled={displayScale <= EXPORT_DISPLAY_SCALE_MIN}
              style={{
                border: `1px solid ${THEME.border}`,
                color: THEME.text,
                background: "transparent",
                opacity: displayScale <= EXPORT_DISPLAY_SCALE_MIN ? 0.5 : 1,
              }}
              className="w-7 h-7 rounded-lg font-bold text-sm"
            >
              −
            </button>
            <span style={{ color: THEME.text, width: 48 }} className="text-center font-bold text-sm">
              {Math.round(displayScale * 100)}%
            </span>
            <button
              type="button"
              onClick={() =>
                onDisplayScaleChange(Math.min(EXPORT_DISPLAY_SCALE_MAX, Math.round((displayScale + EXPORT_DISPLAY_SCALE_STEP) * 100) / 100))
              }
              disabled={displayScale >= EXPORT_DISPLAY_SCALE_MAX}
              style={{
                border: `1px solid ${THEME.border}`,
                color: THEME.text,
                background: "transparent",
                opacity: displayScale >= EXPORT_DISPLAY_SCALE_MAX ? 0.5 : 1,
              }}
              className="w-7 h-7 rounded-lg font-bold text-sm"
            >
              ＋
            </button>
            <button
              type="button"
              onClick={() => onDisplayScaleChange(EXPORT_DISPLAY_SCALE_DEFAULT)}
              style={{ border: `1px solid ${THEME.border}`, color: THEME.text, background: "transparent" }}
              className="px-2 py-1 rounded-lg text-xs font-bold"
            >
              100%に戻す
            </button>
          </div>
        </div>

        {/* ビュー：現在のビュー / 平面図 / 俯瞰客席（14章：既存top/audienceの描画ロジックを
            そのまま再利用。ここでは選択だけを行う） */}
        <div className="flex flex-col gap-2">
          <span className="text-xs" style={sectionTitleStyle}>
            ビュー
          </span>
          <label style={radioRowStyle} className="text-sm" title={`現在の画面のビュー（${currentViewLabel}）で出力します`}>
            <input type="radio" name="export-view-choice" checked={viewChoice === "current"} onChange={() => onViewChoiceChange("current")} />
            <span style={{ color: THEME.text }}>現在のビュー（{currentViewLabel}）</span>
          </label>
          <label style={radioRowStyle} className="text-sm">
            <input type="radio" name="export-view-choice" checked={viewChoice === "top"} onChange={() => onViewChoiceChange("top")} />
            <span style={{ color: THEME.text }}>平面図</span>
          </label>
          <label style={radioRowStyle} className="text-sm">
            <input type="radio" name="export-view-choice" checked={viewChoice === "front"} onChange={() => onViewChoiceChange("front")} />
            <span style={{ color: THEME.text }}>俯瞰客席</span>
          </label>
        </div>

        {/* 形式：v1.2でPDFを追加。「どの構成を出力するか」（targetMode）とは独立した設定で、
            PNG/ZIPの既存挙動には一切影響しない（PDFを選んだ時だけ別経路を通る）。 */}
        <div className="flex flex-col gap-2">
          <span className="text-xs" style={sectionTitleStyle}>
            形式
          </span>
          <label style={radioRowStyle} className="text-sm">
            <input type="radio" name="export-format" checked={format === "png"} onChange={() => onFormatChange("png")} />
            <span style={{ color: THEME.text }}>PNG（1構成なら画像、複数構成ならZIP）</span>
          </label>
          <label style={radioRowStyle} className="text-sm">
            <input type="radio" name="export-format" checked={format === "pdf"} onChange={() => onFormatChange("pdf")} />
            <span style={{ color: THEME.text }}>PDF（1ファイル・複数構成は複数ページ）</span>
          </label>
        </div>

        {error && (
          <div
            className="flex items-center justify-between gap-2 text-xs"
            style={{ color: THEME.danger, background: THEME.panelBg2, border: `1px solid ${THEME.danger}`, borderRadius: 8, padding: "6px 10px" }}
          >
            <span>{error}</span>
            <button type="button" onClick={onDismissError} style={{ color: THEME.danger, fontWeight: 700 }} aria-label="エラーメッセージを閉じる">
              ✕
            </button>
          </div>
        )}

        <div className="flex justify-end gap-2" style={{ flexShrink: 0 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{ border: `1px solid ${THEME.border}`, color: THEME.text, background: "transparent", opacity: busy ? 0.5 : 1 }}
            className="px-3 py-1.5 rounded-lg text-sm font-bold"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={onConfirmExport}
            disabled={confirmDisabled}
            style={{
              background: confirmDisabled ? THEME.panelBg2 : THEME.accent,
              color: confirmDisabled ? THEME.textDim : "#141318",
              border: `1px solid ${confirmDisabled ? THEME.border : THEME.accent}`,
              opacity: confirmDisabled ? 0.7 : 1,
              cursor: confirmDisabled ? "not-allowed" : "pointer",
            }}
            className="px-3 py-1.5 rounded-lg text-sm font-bold"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// 複数選択時「選択中の出演者を削除」用の確認モーダル。
// window.confirm()はサンドボックス化されたプレビュー環境だとブロックされて何も起きないことがあるため、
// アプリ内で完結する確認UIとして実装している。
function ConfirmDeleteModal({ count, onConfirm, onCancel }) {
  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 210,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: THEME.panelBg,
          border: `1px solid ${THEME.border}`,
          borderRadius: 14,
          padding: 20,
          minWidth: 280,
          maxWidth: "80vw",
        }}
      >
        <p style={{ color: THEME.text }} className="text-sm font-bold mb-4">
          選択中の{count}人を削除しますか？
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            style={{ border: `1px solid ${THEME.border}`, color: THEME.text, background: "transparent" }}
            className="px-3 py-1.5 rounded-lg text-sm font-bold"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={{ background: THEME.danger, color: "#141318", border: `1px solid ${THEME.danger}` }}
            className="px-3 py-1.5 rounded-lg text-sm font-bold"
          >
            削除する
          </button>
        </div>
      </div>
    </div>
  );
}

// 出演者一括追加 v1：「何人追加しますか？」を尋ねる小さなmodal。ConfirmDeleteModalと同じ
// 見た目・同じ「背景クリックで閉じる」挙動を踏襲しつつ、number inputと「現在／追加後」の
// 人数プレビューを持つ。入力値の検証（整数・1以上・残り枠以下）はこのmodal内で完結させ、
// 呼び出し側（App）へは常に「確定した安全な人数」だけをonConfirmで渡す。
function BulkAddPerformersModal({ currentCount, maxCount, onConfirm, onCancel }) {
  const remaining = Math.max(0, maxCount - currentCount);
  const [raw, setRaw] = useState(remaining > 0 ? String(Math.min(10, remaining)) : "");

  // 入力値を「1以上・整数・残り枠以下」に安全化する。空文字・0・負数・小数・NaNはnullを返す
  // （＝確定不可）。10.5のような小数は切り捨てず「そのままでは受け付けない」方針にし、
  // 出演者数という整数値の意味を暗黙に変えない。
  const parsed = (() => {
    if (raw.trim() === "") return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    if (!Number.isInteger(n)) return null;
    if (n <= 0) return null;
    return n;
  })();
  const clamped = parsed != null ? Math.min(parsed, remaining) : null;
  const canConfirm = remaining > 0 && clamped != null && clamped > 0;
  const afterCount = currentCount + (clamped || 0);

  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 210,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: THEME.panelBg,
          border: `1px solid ${THEME.border}`,
          borderRadius: 14,
          padding: 20,
          minWidth: 280,
          maxWidth: "80vw",
        }}
      >
        <p style={{ color: THEME.text }} className="text-sm font-bold mb-3">
          何人追加しますか？
        </p>

        {remaining > 0 ? (
          <>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={remaining}
              step={1}
              autoFocus
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canConfirm) {
                  e.preventDefault();
                  onConfirm(clamped);
                }
              }}
              style={{ ...inputStyle, width: "100%" }}
              className="mb-2"
            />
            <p style={{ color: THEME.textDim }} className="text-xs mb-4">
              現在：{currentCount}人　→　追加後：{afterCount}人（あと{remaining}人まで追加可能）
            </p>
          </>
        ) : (
          <p style={{ color: THEME.textDim }} className="text-xs mb-4">
            すでに上限（{maxCount}人）に達しているため、これ以上追加できません。
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            style={{ border: `1px solid ${THEME.border}`, color: THEME.text, background: "transparent" }}
            className="px-3 py-1.5 rounded-lg text-sm font-bold"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={() => canConfirm && onConfirm(clamped)}
            disabled={!canConfirm}
            style={{
              background: canConfirm ? THEME.accent : THEME.borderSoft,
              color: canConfirm ? "#141318" : THEME.textDim,
              border: `1px solid ${canConfirm ? THEME.accent : THEME.border}`,
              cursor: canConfirm ? "pointer" : "not-allowed",
            }}
            className="px-3 py-1.5 rounded-lg text-sm font-bold"
          >
            {clamped ? `${clamped}人追加` : "追加"}
          </button>
        </div>
      </div>
    </div>
  );
}

// 構成削除の確認モーダル。出演者の複数削除確認モーダルと見た目は揃えつつ、
// 構成削除専用の文言（構成名を含む）にするため別コンポーネントとして分離してある。
// 一括削除 v1・11章：複数構成削除の確認モーダル。既存のConfirmDeleteSlideModal（単体・
// slideName前提）を無理に流用せず、件数ベースの小さな専用モーダルとして分離する。
// デザイン思想（背景クリック=キャンセル・危険操作はTHEME.danger）は完全に同じにする。
function ConfirmDeleteSlidesModal({ count, onConfirm, onCancel }) {
  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 210,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: THEME.panelBg,
          border: `1px solid ${THEME.border}`,
          borderRadius: 14,
          padding: 20,
          minWidth: 280,
          maxWidth: "80vw",
        }}
      >
        <p style={{ color: THEME.text }} className="text-sm font-bold mb-1">
          選択した{count}構成を削除しますか？
        </p>
        <p style={{ color: THEME.textDim }} className="text-xs leading-relaxed mb-4">
          この操作はUndoで元に戻せます。
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            style={{ border: `1px solid ${THEME.border}`, color: THEME.text, background: "transparent" }}
            className="px-3 py-1.5 rounded-lg text-sm font-bold"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={{ background: THEME.danger, color: "#141318", border: `1px solid ${THEME.danger}` }}
            className="px-3 py-1.5 rounded-lg text-sm font-bold"
          >
            削除する
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmDeleteSlideModal({ slideName, onConfirm, onCancel }) {
  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 210,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: THEME.panelBg,
          border: `1px solid ${THEME.border}`,
          borderRadius: 14,
          padding: 20,
          minWidth: 280,
          maxWidth: "80vw",
        }}
      >
        <p style={{ color: THEME.text }} className="text-sm font-bold mb-4">
          構成「{slideName}」を削除しますか？
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            style={{ border: `1px solid ${THEME.border}`, color: THEME.text, background: "transparent" }}
            className="px-3 py-1.5 rounded-lg text-sm font-bold"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={{ background: THEME.danger, color: "#141318", border: `1px solid ${THEME.danger}` }}
            className="px-3 py-1.5 rounded-lg text-sm font-bold"
          >
            削除する
          </button>
        </div>
      </div>
    </div>
  );
}

// Project間コピー v1・5章：Project間でCtrl+Vした際、貼り付け先Projectにnumber+name一致の
// 出演者がいない人がいる場合に、Paste実行前に表示する確認モーダル。ConfirmDeleteModal・
// ConfirmDeleteSlideModalと同じ見た目・同じ「背景クリックで閉じる（＝キャンセル）」挙動を
// 踏襲する。unmatchedPerformersは{id, number, name}の配列（buildCrossProjectPerformerMapping
// の戻り値をそのまま渡す想定）。「そのまま貼り付ける」を押すと、これらの出演者のplacementだけ
// 除外した状態でPasteが実行される（実際の処理はApp側のconfirmCrossProjectPasteが行う。
// このコンポーネント自体はUI表示だけの責務）。
// isBulkPaste: 複数構成一括コピー v1・STEP8。trueの場合、「選択した構成内のこれらの出演者の
// 配置・移動経路は除外されます」という複数構成向けの文言を使う（「コピーしたN構成すべてで
// 配置されません」という誤解を招く表現は使わない＝各出演者が全構成に登場するとは限らないため）。
// falseまたは省略時（単体Project間コピー）は既存の文言をそのまま維持する。
function CrossProjectPasteWarningModal({ unmatchedPerformers, isBulkPaste, onConfirm, onCancel }) {
  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 210,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: THEME.panelBg,
          border: `1px solid ${THEME.border}`,
          borderRadius: 14,
          padding: 20,
          minWidth: 280,
          maxWidth: "80vw",
        }}
      >
        <p style={{ color: THEME.text }} className="text-sm font-bold mb-2">
          {isBulkPaste ? "貼り付け先Projectに一致する出演者がいません。" : "貼り付け先Projectに存在しない出演者があります。"}
        </p>
        <ul style={{ color: THEME.textDim }} className="text-xs leading-relaxed mb-3 pl-1">
          {unmatchedPerformers.map((p) => (
            <li key={p.id}>
              {Number.isFinite(Number(p.number)) ? `${p.number}番 ` : ""}
              {p.name || "（名前未設定）"}
            </li>
          ))}
        </ul>
        <p style={{ color: THEME.textDim }} className="text-xs leading-relaxed mb-4">
          {isBulkPaste
            ? "そのまま貼り付けると、選択した構成内のこれらの出演者の配置・移動経路は除外されます。"
            : "このまま貼り付けると、これらの出演者は配置されません。"}
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            style={{ border: `1px solid ${THEME.border}`, color: THEME.text, background: "transparent" }}
            className="px-3 py-1.5 rounded-lg text-sm font-bold"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={{ background: THEME.accent, color: "#141318", border: `1px solid ${THEME.accent}` }}
            className="px-3 py-1.5 rounded-lg text-sm font-bold"
          >
            そのまま貼り付ける
          </button>
        </div>
      </div>
    </div>
  );
}

