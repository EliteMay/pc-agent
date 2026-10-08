using System.Threading;
using System.Windows.Forms;

namespace PcAgentManager.Services;

/// <summary>
/// Local, synthetic, zero-mutation WinForms preview. There is no move request,
/// signer, replay journal, IPC connection, Agent process, or filesystem action.
/// The automatic mode is a short, unattended real-window smoke test and
/// MUST exit by denial. Preview is invoked only with an explicit local CLI
/// switch; the normal Manager runtime does not open it.
/// </summary>
internal static class LocalMoveDialogPreviewRunner
{
    internal static int Run(bool autoDeny)
    {
        if (!OperatingSystem.IsWindows()
            || Thread.CurrentThread.GetApartmentState() != ApartmentState.STA)
        {
            return 72;
        }

        Application.SetHighDpiMode(HighDpiMode.SystemAware);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        var now = DateTimeOffset.UtcNow;
        var displayed = new LocalMoveDialogConsentPrototype.DialogChallenge(
            new string('0', 32),
            "PREVIEW-NO-COMMAND",
            "PREVIEW-NO-DEVICE",
            "PREVIEW-NO-OPERATION",
            @"C:\PREVIEW_ONLY\source.txt",
            @"C:\PREVIEW_ONLY\destination.txt",
            @"C:\PREVIEW_ONLY",
            new string('0', 64),
            now,
            now.AddSeconds(30));

        using var form = new LocalMoveConfirmationFormPrototype(
            displayed, previewOnly: true);

        if (autoDeny)
        {
            using var closeTimer = new System.Windows.Forms.Timer
            {
                Interval = 750
            };
            closeTimer.Tick += (_, _) =>
            {
                closeTimer.Stop();
                form.DialogResult = DialogResult.No;
                form.Close();
            };
            form.Shown += (_, _) => closeTimer.Start();

            var result = form.ShowDialog();
            return result == DialogResult.No && !form.ApprovedByExplicitClick
                ? 0 : 73;
        }

        // A manual click is only feedback about the demo UI. Do NOT call
        // LocalMoveDialogConsentPrototype, ticket signer or native mover.
        _ = form.ShowDialog();
        return 0;
    }
}
