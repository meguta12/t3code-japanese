import { ja } from "../../lib/ja";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button, InlineButton } from "../ui/button";
import { useT3ConnectAccountPage } from "./T3ConnectAccountPages";

/**
 * Confirms removing a T3 Connect environment from this device. Removal here
 * leaves the account registration (and its host space) in place, so the dialog
 * says so and links to the account page where it can be deregistered.
 */
export function RemoveT3ConnectEnvironmentDialog({
  environmentLabel,
  onCancel,
  onConfirm,
}: {
  /** The environment awaiting confirmation; null keeps the dialog closed. */
  readonly environmentLabel: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const accountPage = useT3ConnectAccountPage();
  // Keep the label through the close animation.
  const [shownLabel, setShownLabel] = useState(environmentLabel);
  if (environmentLabel !== null && environmentLabel !== shownLabel) setShownLabel(environmentLabel);
  const openAccountPage = accountPage.open;

  return (
    <>
      <AlertDialog
        open={environmentLabel !== null}
        onOpenChange={(open) => {
          if (!open) onCancel();
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>このデバイスから「{shownLabel}」を削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              このデバイスから接続情報・認証情報・チャットのキャッシュを削除します。
            </AlertDialogDescription>
            <AlertDialogDescription>
              T3 Connectのアカウントには残り、環境の登録枠も使用したままです。枠を空けるには{" "}
              {openAccountPage ? (
                <InlineButton
                  onClick={() => {
                    onCancel();
                    openAccountPage();
                  }}
                >
                  T3 Connectの設定
                </InlineButton>
              ) : (
                ja("T3 Connect settings")
              )}{" "}
              で登録を解除してください。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>キャンセル</AlertDialogClose>
            <Button variant="destructive" onClick={onConfirm}>
              このデバイスから削除
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {accountPage.portals}
    </>
  );
}
