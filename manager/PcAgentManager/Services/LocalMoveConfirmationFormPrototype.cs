using System.Drawing;
using System.Globalization;
using System.Windows.Forms;

namespace PcAgentManager.Services;

/// <summary>
/// EXPERIMENTAL on-device WinForms dialog for a single captured native move.
/// This dialog has NO production entry point or Agent/IPC registration.
/// Even a genuine click is not sufficient for file mutation by itself:
/// a separate immutable ticket, durable replay reservation and filesystem
/// validation remain mandatory.
/// </summary>
internal sealed class LocalMoveConfirmationFormPrototype : Form
{
    private readonly CheckBox _acknowledged;
    private readonly Button _approve;
    private readonly System.Windows.Forms.Timer _expirationTimer = new() { Interval = 200 };
    private readonly DateTimeOffset _expiresAt;
    private bool _explicitApprovalClick;
    private bool _expired;

    internal LocalMoveConfirmationFormPrototype(
        LocalMoveDialogConsentPrototype.DialogChallenge displayed,
        bool previewOnly = false)
    {
        ArgumentNullException.ThrowIfNull(displayed);
        _expiresAt = displayed.ExpiresAt;

        Text = previewOnly
            ? "PC Agent - 確認画面プレビュー（ファイル操作なし）"
            : "PC Agent - ファイル移動の確認（実験用）";
        Size = new Size(820, 680);
        MinimumSize = new Size(660, 540);
        StartPosition = FormStartPosition.CenterParent;
        AutoScaleMode = AutoScaleMode.Font;
        BackColor = Color.FromArgb(18, 18, 18);
        ForeColor = Color.Gainsboro;
        Font = new Font("Segoe UI", 10F);
        ShowInTaskbar = false;
        TopMost = true;

        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 4,
            Padding = new Padding(18),
            BackColor = BackColor
        };
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        root.Controls.Add(new Label
        {
            AutoSize = true,
            Text = previewOnly
                ? "これはプレビューです。確認してもファイルは移動されません。"
                : "このファイル移動を許可する前に、対象を確認してください。",
            Font = new Font(Font.FontFamily, 12F, FontStyle.Bold),
            Margin = new Padding(0, 0, 0, 12)
        }, 0, 0);

        // The exact immutable request fields are displayed, not a string
        // summary supplied independently by an untrusted queue message.
        var details = new TextBox
        {
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Both,
            WordWrap = false,
            Dock = DockStyle.Fill,
            BackColor = Color.FromArgb(27, 27, 27),
            ForeColor = Color.WhiteSmoke,
            Font = new Font("Consolas", 10F),
            Text = string.Join(Environment.NewLine, new[]
            {
                "操作ID: " + displayed.OperationId,
                "コマンドID: " + displayed.CommandId,
                "デバイスID: " + displayed.DeviceId,
                "",
                "移動元:",
                displayed.SourcePath,
                "",
                "移動先:",
                displayed.DestinationPath,
                "",
                "許可されたルート:",
                displayed.AllowedRootPath,
                "",
                "移動元ファイル SHA-256:",
                displayed.SourceSha256,
                "",
                "確認期限: " + displayed.ExpiresAt.ToLocalTime().ToString(
                    "yyyy-MM-dd HH:mm:ss zzz", CultureInfo.InvariantCulture)
            })
        };
        root.Controls.Add(details, 0, 1);

        _acknowledged = new CheckBox
        {
            Text = "移動元と移動先、操作IDを確認しました",
            AutoSize = true,
            Checked = false,
            Margin = new Padding(0, 14, 0, 12),
            ForeColor = Color.Gainsboro
        };
        root.Controls.Add(_acknowledged, 0, 2);

        var buttons = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            AutoSize = true,
            FlowDirection = FlowDirection.RightToLeft,
            WrapContents = false
        };

        _approve = new Button
        {
            Text = previewOnly
                ? "確認（プレビューのみ）"
                : "内容を確認して許可",
            AutoSize = true,
            MinimumSize = new Size(180, 40),
            Enabled = false,
            // Do not let WinForms grant Yes just by setting a DialogResult.
            // Only the checked, non-expired Click callback below may do it.
            BackColor = Color.FromArgb(35, 85, 60),
            ForeColor = Color.White
        };
        var deny = new Button
        {
            Text = "拒否・閉じる",
            AutoSize = true,
            MinimumSize = new Size(160, 40),
            DialogResult = DialogResult.No,
            BackColor = Color.FromArgb(88, 32, 32),
            ForeColor = Color.White
        };
        _acknowledged.CheckedChanged += (_, _) =>
            _approve.Enabled = _acknowledged.Checked && !_expired
                && DateTimeOffset.UtcNow < _expiresAt;

        _approve.Click += (_, _) =>
        {
            if (!_acknowledged.Checked || _expired
                || DateTimeOffset.UtcNow >= _expiresAt)
            {
                DenyAndClose();
                return;
            }

            _explicitApprovalClick = true;
            DialogResult = DialogResult.Yes;
            Close();
        };

        _expirationTimer.Tick += (_, _) =>
        {
            if (DateTimeOffset.UtcNow < _expiresAt) return;
            _expired = true;
            _approve.Enabled = false;
            DenyAndClose();
        };
        Shown += (_, _) =>
        {
            if (DateTimeOffset.UtcNow >= _expiresAt)
            {
                _expired = true;
                DenyAndClose();
                return;
            }

            _expirationTimer.Start();
        };

        buttons.Controls.Add(_approve);
        buttons.Controls.Add(deny);
        root.Controls.Add(buttons, 0, 3);
        Controls.Add(root);

        // A bare Enter key must never approve a sensitive mutation.
        // Escape and the window close control both mean denial.
        CancelButton = deny;
        FormClosing += (_, _) =>
        {
            _expirationTimer.Stop();
            if (!_explicitApprovalClick || DialogResult != DialogResult.Yes
                || DateTimeOffset.UtcNow >= _expiresAt)
            {
                _explicitApprovalClick = false;
                DialogResult = DialogResult.No;
            }
        };
    }

    private void DenyAndClose()
    {
        _explicitApprovalClick = false;
        DialogResult = DialogResult.No;
        Close();
    }

    // This only confirms the form's explicit, unexpired click callback ran.
    // It is NOT proof that a human caused the input on an untrusted desktop.
    internal bool ApprovedByExplicitClick =>
        _explicitApprovalClick && DialogResult == DialogResult.Yes
        && DateTimeOffset.UtcNow < _expiresAt;

    // These inspection members allow non-interactive Windows form unit tests.
    // They do NOT mint approval tickets or execute a filesystem operation.
    internal bool IsApprovalEnabledForTest => _approve.Enabled;
    internal void SetAcknowledgedForTest(bool value) => _acknowledged.Checked = value;

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _expirationTimer.Dispose();
        }

        base.Dispose(disposing);
    }
}
