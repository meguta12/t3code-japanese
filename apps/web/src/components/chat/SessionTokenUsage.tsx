import type { ContextWindowSnapshot } from "../../lib/contextWindow";
import { deriveSessionTokenUsage, formatSessionTokens } from "../../lib/sessionTokenUsage";
import { composerFloatingLayerProps } from "./composerEventScope";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

export function SessionTokenUsage({
  usage,
  showContext = false,
}: {
  usage: ContextWindowSnapshot | null;
  showContext?: boolean;
}) {
  const tokens = deriveSessionTokenUsage(usage);
  const visibleTokens = showContext ? tokens.contextTokens : tokens.totalTokens;
  const visibleLabel = showContext ? "現在" : "累計";
  const rows = [
    ["直近の処理", tokens.lastTokens],
    ["入力（キャッシュ含む）", tokens.inputTokens],
    ["うちキャッシュ", tokens.cachedTokens],
    ["出力（思考含む）", tokens.outputTokens],
    ["うち思考", tokens.reasoningTokens],
    ["現在のコンテキスト", tokens.contextTokens],
  ] as const;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="compact"
            variant="ghost-muted"
            type="button"
            aria-label={`${visibleLabel} ${formatSessionTokens(visibleTokens)}トークン。内訳を開く`}
          />
        }
      >
        <span className="tabular-nums">
          {visibleLabel} {visibleTokens === null ? "—" : formatSessionTokens(visibleTokens, true)}
        </span>
        <span>トークン</span>
        {showContext && usage?.usedPercentage !== null && usage?.usedPercentage !== undefined ? (
          <span className="tabular-nums">· {Math.round(usage.usedPercentage)}%</span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup
        {...(showContext ? composerFloatingLayerProps : {})}
        width="md"
        side={showContext ? "top" : "bottom"}
        align="end"
      >
        <div className="flex flex-col gap-3">
          <PopoverTitle>このセッションのトークン使用量</PopoverTitle>
          <span className="text-xs text-muted-foreground">セッション累計</span>
          <div className="text-xl font-semibold tabular-nums">
            {formatSessionTokens(tokens.totalTokens)}
            {tokens.totalTokens !== null ? <span className="ml-1 text-xs">トークン</span> : null}
          </div>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 text-xs">
            {rows.map(([label, count]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right tabular-nums">{formatSessionTokens(count)}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs leading-relaxed text-muted-foreground">
            累計はモデルが報告した現在のセッションの処理量です。会話を送り直した分も含みます。
            キャッシュ・思考は入力・出力の内数です。コンテキストや契約の残量とは別の数字です。
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            圧縮すると現在のコンテキスト量が減ります。すでに処理した累計は減りません。
            セッションを作り直すと累計がリセットされる場合があります。報告のない数値は「未取得」と表示します。
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
