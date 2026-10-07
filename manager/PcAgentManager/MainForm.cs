using PcAgentManager.Configuration;
using PcAgentManager.Models;
using PcAgentManager.Services;
using PcAgentManager.Supervision;

namespace PcAgentManager;

public sealed class MainForm : Form
{
    private readonly ManagerPaths _paths;
    private readonly ManagerConfigurationStore _configStore;
    private readonly AgentSupervisor _supervisor;
    private readonly bool _backgroundStart;

    private readonly Label _agentValue = ValueLabel();
    private readonly Label _supabaseValue = ValueLabel();
    private readonly Label _heartbeatValue = ValueLabel();
    private readonly Label _versionValue = ValueLabel();
    private readonly Label _errorValue = ValueLabel();
    private readonly Button _start = ActionButton("Start");
    private readonly Button _stop = ActionButton("Stop");
    private readonly Button _restart = ActionButton("Restart");
    private readonly Button _diagnose = ActionButton("Diagnose");
    private readonly Button _configure = ActionButton("設定");
    private readonly Button _emergency = ActionButton("EMERGENCY STOP");
    private readonly Button _resume = ActionButton("Emergency Stop解除");
    private readonly NotifyIcon _tray = new();
    private bool _allowExit;
    private string? _approvalDialogOperationId;

    public MainForm(
        ManagerPaths paths,
        ManagerConfigurationStore configStore,
        AgentSupervisor supervisor,
        bool backgroundStart)
    {
        _paths = paths;
        _configStore = configStore;
        _supervisor = supervisor;
        _backgroundStart = backgroundStart;

        Text = "PC Agent Manager";
        Size = new Size(620, 500);
        MinimumSize = new Size(560, 450);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(18, 18, 18);
        ForeColor = Color.Gainsboro;

        var title = new Label
        {
            Text = "PC Agent",
            Font = new Font(Font.FontFamily, 22, FontStyle.Bold),
            AutoSize = true,
            Margin = new Padding(0, 0, 0, 18)
        };

        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(24),
            ColumnCount = 1,
            AutoScroll = true
        };

        root.Controls.Add(title);

        var status = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            ColumnCount = 2,
            AutoSize = true
        };
        status.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 150));
        status.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

        AddStatus(status, "Agent", _agentValue);
        AddStatus(status, "Supabase", _supabaseValue);
        AddStatus(status, "Heartbeat", _heartbeatValue);
        AddStatus(status, "Version", _versionValue);
        AddStatus(status, "Last error", _errorValue);
        root.Controls.Add(status);

        var actions = new FlowLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            Margin = new Padding(0, 20, 0, 0)
        };
        actions.Controls.AddRange([_start, _stop, _restart, _diagnose, _configure]);
        root.Controls.Add(actions);

        _emergency.BackColor = Color.FromArgb(110, 25, 25);
        _emergency.ForeColor = Color.White;
        _emergency.Margin = new Padding(0, 24, 8, 0);
        _resume.Margin = new Padding(0, 24, 8, 0);

        var emergencyRow = new FlowLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Top
        };
        emergencyRow.Controls.Add(_emergency);
        emergencyRow.Controls.Add(_resume);
        root.Controls.Add(emergencyRow);

        Controls.Add(root);

        _start.Click += async (_, _) => await _supervisor.StartAsync();
        _stop.Click += async (_, _) => await _supervisor.StopAsync();
        _restart.Click += async (_, _) => await _supervisor.RestartAsync();
        _emergency.Click += async (_, _) =>
        {
            if (MessageBox.Show(
                    this,
                    "Agentを停止し、自動再起動をロックします。解除するまで再開しません。",
                    "Emergency Stop",
                    MessageBoxButtons.OKCancel,
                    MessageBoxIcon.Warning) == DialogResult.OK)
            {
                await _supervisor.EmergencyStopAsync();
            }
        };
        _resume.Click += (_, _) =>
        {
            _supervisor.ClearEmergencyStop();
            Render(_supervisor.Snapshot);
        };
        _diagnose.Click += (_, _) => ShowDiagnostics();
        _configure.Click += (_, _) => ShowConfiguration();

        _supervisor.SnapshotChanged += SupervisorOnSnapshotChanged;
        _supervisor.PendingApprovalChanged += SupervisorOnPendingApprovalChanged;

        ConfigureTray();
        FormClosing += MainFormClosing;
        Shown += MainFormShown;

        Render(_supervisor.Snapshot);
    }

    private async void MainFormShown(object? sender, EventArgs e)
    {
        var config = _configStore.Load();
        var validation = AgentConfigurationValidator.Validate(config);

        if (!validation.IsValid &&
            (string.IsNullOrWhiteSpace(config.DeviceId) ||
             string.IsNullOrWhiteSpace(config.DeviceToken)))
        {
            var imported = _configStore.TryAutoImportLegacyCredentials();

            if (imported.Found)
            {
                config = _configStore.Load();
                validation = AgentConfigurationValidator.Validate(config);

                if (!_backgroundStart)
                {
                    MessageBox.Show(
                        this,
                        "既存のPC Agent設定を自動で移行しました。Device ID / Token の入力は不要です。",
                        "PC Agent",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information);
                }
            }
        }

        if (!validation.IsValid)
        {
            Show();
            Activate();
            ShowConfiguration();
            return;
        }

        if (_backgroundStart)
        {
            Hide();
        }

        if (config.AutoStartAgent && !_supervisor.Snapshot.EmergencyStopped)
        {
            await _supervisor.StartAsync();
        }
    }

    private void SupervisorOnSnapshotChanged(object? sender, ManagerSnapshot snapshot)
    {
        if (IsDisposed) return;

        if (InvokeRequired)
        {
            BeginInvoke(() => Render(snapshot));
        }
        else
        {
            Render(snapshot);
        }
    }

    private void SupervisorOnPendingApprovalChanged(PendingApprovalSnapshot? pending)
    {
        if (IsDisposed || pending is null)
        {
            return;
        }

        if (InvokeRequired)
        {
            BeginInvoke(() => SupervisorOnPendingApprovalChanged(pending));
            return;
        }

        if (string.Equals(
                _approvalDialogOperationId,
                pending.OperationId,
                StringComparison.Ordinal))
        {
            return;
        }

        _ = ShowApprovalDialogAsync(pending);
    }

    private async Task ShowApprovalDialogAsync(PendingApprovalSnapshot pending)
    {
        _approvalDialogOperationId = pending.OperationId;

        try
        {
            Show();
            WindowState = FormWindowState.Normal;
            Activate();

            var summaryText = pending.Summary.ValueKind is
                System.Text.Json.JsonValueKind.Undefined or
                System.Text.Json.JsonValueKind.Null
                ? "(詳細なし)"
                : System.Text.Json.JsonSerializer.Serialize(
                    pending.Summary,
                    new System.Text.Json.JsonSerializerOptions
                    {
                        WriteIndented = true
                    });

            using var dialog = new Form
            {
                Text = "PC Agent - 操作の確認",
                Size = new Size(640, 520),
                MinimumSize = new Size(560, 440),
                StartPosition = FormStartPosition.CenterParent,
                BackColor = Color.FromArgb(18, 18, 18),
                ForeColor = Color.Gainsboro,
                TopMost = true
            };

            var root = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                Padding = new Padding(20),
                ColumnCount = 1,
                RowCount = 6
            };

            root.Controls.Add(new Label
            {
                Text = "PCに変更を加える操作が要求されています。",
                AutoSize = true,
                Font = new Font(Font.FontFamily, 13, FontStyle.Bold),
                Margin = new Padding(0, 0, 0, 12)
            });

            root.Controls.Add(new Label
            {
                Text = $"Tool: {pending.Tool}    Risk: {pending.Risk}",
                AutoSize = true,
                Margin = new Padding(0, 0, 0, 8)
            });

            var details = new TextBox
            {
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Both,
                Dock = DockStyle.Fill,
                Text = summaryText,
                BackColor = Color.FromArgb(28, 28, 28),
                ForeColor = Color.WhiteSmoke,
                Font = new Font("Consolas", 10)
            };
            root.Controls.Add(details);

            root.Controls.Add(new Label
            {
                Text = "内容を確認して、許可する場合だけ「許可」を押してください。",
                AutoSize = true,
                Margin = new Padding(0, 10, 0, 10)
            });

            var buttons = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.RightToLeft,
                AutoSize = true
            };

            var approve = ActionButton("許可");
            var deny = ActionButton("拒否");
            deny.BackColor = Color.FromArgb(90, 30, 30);

            buttons.Controls.Add(approve);
            buttons.Controls.Add(deny);
            root.Controls.Add(buttons);
            dialog.Controls.Add(root);

            bool approved = false;
            approve.Click += (_, _) =>
            {
                approved = true;
                dialog.DialogResult = DialogResult.OK;
                dialog.Close();
            };
            deny.Click += (_, _) =>
            {
                approved = false;
                dialog.DialogResult = DialogResult.Cancel;
                dialog.Close();
            };

            dialog.FormClosing += (_, e) =>
            {
                if (dialog.DialogResult == DialogResult.None)
                {
                    approved = false;
                    dialog.DialogResult = DialogResult.Cancel;
                }
            };

            _tray.ShowBalloonTip(
                5000,
                "PC Agent",
                "PCへの変更操作が確認待ちです。",
                ToolTipIcon.Warning);

            dialog.ShowDialog(this);

            using var responseCts = new CancellationTokenSource(
                TimeSpan.FromSeconds(3));

            var accepted = await _supervisor.RespondApprovalAsync(
                pending.OperationId,
                approved,
                responseCts.Token);

            if (!accepted)
            {
                MessageBox.Show(
                    this,
                    "確認結果をAgentへ送れませんでした。操作は実行されません。",
                    "PC Agent",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                this,
                "確認処理でエラーが発生しました。操作は許可されていません。\n" + ex.Message,
                "PC Agent",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
        finally
        {
            _approvalDialogOperationId = null;
        }
    }

    private void Render(ManagerSnapshot snapshot)
    {
        _agentValue.Text = snapshot.AgentState;
        _supabaseValue.Text = snapshot.QueueConnectivity;
        _heartbeatValue.Text = snapshot.LastHeartbeat is null
            ? "未確認"
            : $"{Math.Max(0, (DateTimeOffset.UtcNow - snapshot.LastHeartbeat.Value).TotalSeconds):0}s ago";
        _versionValue.Text = string.IsNullOrWhiteSpace(snapshot.AgentVersion)
            ? "-"
            : snapshot.AgentVersion;
        _errorValue.Text = snapshot.LastError ?? "-";

        _start.Enabled = !snapshot.EmergencyStopped &&
            snapshot.ManagerState is not "RUNNING";
        _stop.Enabled = snapshot.ProcessId is not null;
        _restart.Enabled = !snapshot.EmergencyStopped &&
            snapshot.ProcessId is not null;
        _emergency.Enabled = !snapshot.EmergencyStopped;
        _resume.Enabled = snapshot.EmergencyStopped;
    }

    private void ShowConfiguration()
    {
        var existing = _configStore.Load();
        using var dialog = new ConfigurationDialog(existing);

        if (dialog.ShowDialog(this) != DialogResult.OK || dialog.Result is null)
        {
            return;
        }

        _configStore.Save(dialog.Result);

        try
        {
            StartupRegistration.SetEnabled(dialog.Result.AutoStartManager);
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                this,
                "設定は保存しましたがWindows自動起動の更新に失敗しました。\n" + ex.Message,
                "PC Agent",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }

        MessageBox.Show(
            this,
            "設定を保存しました。Agent設定の変更はRestartで反映されます。",
            "PC Agent",
            MessageBoxButtons.OK,
            MessageBoxIcon.Information);
    }

    private void ShowDiagnostics()
    {
        var text = _supervisor.BuildDiagnostics();
        using var dialog = new Form
        {
            Text = "PC Agent Diagnostic",
            Size = new Size(720, 520),
            StartPosition = FormStartPosition.CenterParent,
            BackColor = Color.FromArgb(18, 18, 18),
            ForeColor = Color.Gainsboro
        };

        var box = new TextBox
        {
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Both,
            Dock = DockStyle.Fill,
            Text = text,
            BackColor = Color.FromArgb(28, 28, 28),
            ForeColor = Color.WhiteSmoke,
            Font = new Font("Consolas", 10)
        };

        var copy = ActionButton("コピー");
        copy.Dock = DockStyle.Bottom;
        copy.Click += (_, _) => Clipboard.SetText(box.Text);

        dialog.Controls.Add(box);
        dialog.Controls.Add(copy);
        dialog.ShowDialog(this);
    }

    private void ConfigureTray()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("開く", null, (_, _) =>
        {
            Show();
            WindowState = FormWindowState.Normal;
            Activate();
        });
        menu.Items.Add("Agent Start", null, async (_, _) => await _supervisor.StartAsync());
        menu.Items.Add("Agent Stop", null, async (_, _) => await _supervisor.StopAsync());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("終了", null, async (_, _) =>
        {
            _allowExit = true;
            await _supervisor.StopAsync();
            _tray.Visible = false;
            Close();
        });

        _tray.Text = "PC Agent Manager";
        _tray.Icon = SystemIcons.Application;
        _tray.ContextMenuStrip = menu;
        _tray.Visible = true;
        _tray.DoubleClick += (_, _) =>
        {
            Show();
            WindowState = FormWindowState.Normal;
            Activate();
        };
    }

    private void MainFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (_allowExit || e.CloseReason == CloseReason.WindowsShutDown)
        {
            _tray.Visible = false;
            return;
        }

        e.Cancel = true;
        Hide();
    }

    private static void AddStatus(TableLayoutPanel table, string name, Label value)
    {
        table.Controls.Add(new Label
        {
            Text = name,
            AutoSize = true,
            Margin = new Padding(0, 7, 10, 7),
            ForeColor = Color.DarkGray
        });
        value.Margin = new Padding(0, 7, 0, 7);
        table.Controls.Add(value);
    }

    private static Label ValueLabel() => new()
    {
        AutoSize = true,
        Text = "-"
    };

    private static Button ActionButton(string text) => new()
    {
        Text = text,
        AutoSize = true,
        Padding = new Padding(12, 6, 12, 6),
        Margin = new Padding(0, 0, 8, 8),
        BackColor = Color.FromArgb(45, 45, 45),
        ForeColor = Color.WhiteSmoke,
        FlatStyle = FlatStyle.Flat
    };
}
