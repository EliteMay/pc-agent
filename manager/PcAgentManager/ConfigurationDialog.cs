using PcAgentManager.Configuration;

namespace PcAgentManager;

public sealed class ConfigurationDialog : Form
{
    private readonly TextBox _endpoint = new();
    private readonly TextBox _deviceId = new();
    private readonly TextBox _token = new();
    private readonly TextBox _roots = new();
    private readonly CheckBox _autoAgent = new();
    private readonly CheckBox _autoManager = new();
    private readonly AgentConfiguration _existing;

    public AgentConfiguration? Result { get; private set; }

    public ConfigurationDialog(AgentConfiguration existing)
    {
        _existing = existing;

        Text = "PC Agent 設定";
        StartPosition = FormStartPosition.CenterParent;
        Size = new Size(650, 560);
        MinimumSize = new Size(600, 520);
        BackColor = Color.FromArgb(24, 24, 24);
        ForeColor = Color.Gainsboro;

        var table = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(18),
            ColumnCount = 1,
            RowCount = 10,
            AutoScroll = true
        };

        _endpoint.Text = existing.EndpointUrl;
        _deviceId.Text = existing.DeviceId;
        _token.UseSystemPasswordChar = true;
        _token.PlaceholderText = string.IsNullOrEmpty(existing.DeviceToken)
            ? "Device Token を入力"
            : "変更しない場合は空欄";
        _roots.Multiline = true;
        _roots.Height = 100;
        _roots.Text = string.Join(Environment.NewLine, existing.AllowedRoots);
        _autoAgent.Text = "Manager起動時にAgentを開始";
        _autoAgent.Checked = existing.AutoStartAgent;
        _autoManager.Text = "Windowsログイン時にManagerを起動";
        _autoManager.Checked = existing.AutoStartManager;

        var autoImport = CreateButton("既存Agent設定を自動検出");
        autoImport.Click += (_, _) =>
        {
            var result = LegacyDeviceCredentialImporter
                .CreateDefault()
                .TryFind();

            if (!result.Found)
            {
                MessageBox.Show(
                    this,
                    "既存のPC Agent設定は見つかりませんでした。",
                    "PC Agent",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
                return;
            }

            _deviceId.Text = result.DeviceId;
            _token.Text = result.DeviceToken;

            MessageBox.Show(
                this,
                "既存のDevice情報を見つけました。保存を押せば暗号化して移行します。",
                "PC Agent",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        };

        table.Controls.Add(autoImport);

        AddField(table, "Supabase Device Endpoint", _endpoint);
        AddField(table, "Device ID", _deviceId);
        AddField(table, "Device Token（暗号化して保存）", _token);
        AddField(table, "Allowed Roots（1行1フォルダ）", _roots);
        table.Controls.Add(_autoAgent);
        table.Controls.Add(_autoManager);

        var buttons = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.RightToLeft,
            Dock = DockStyle.Fill,
            AutoSize = true
        };

        var save = CreateButton("保存");
        var cancel = CreateButton("キャンセル");
        save.Click += SaveClicked;
        cancel.Click += (_, _) => DialogResult = DialogResult.Cancel;
        buttons.Controls.Add(save);
        buttons.Controls.Add(cancel);
        table.Controls.Add(buttons);

        Controls.Add(table);
        AcceptButton = save;
        CancelButton = cancel;
    }

    private static void AddField(TableLayoutPanel table, string label, Control control)
    {
        table.Controls.Add(new Label
        {
            Text = label,
            AutoSize = true,
            Margin = new Padding(0, 10, 0, 4)
        });

        control.Dock = DockStyle.Top;
        control.BackColor = Color.FromArgb(35, 35, 35);
        control.ForeColor = Color.WhiteSmoke;
        table.Controls.Add(control);
    }

    private static Button CreateButton(string text) => new()
    {
        Text = text,
        AutoSize = true,
        Padding = new Padding(14, 6, 14, 6),
        BackColor = Color.FromArgb(45, 45, 45),
        ForeColor = Color.WhiteSmoke,
        FlatStyle = FlatStyle.Flat
    };

    private void SaveClicked(object? sender, EventArgs e)
    {
        var roots = _roots.Lines
            .Select(line => line.Trim())
            .Where(line => line.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

        var config = new AgentConfiguration
        {
            EndpointUrl = _endpoint.Text.Trim(),
            DeviceId = _deviceId.Text.Trim(),
            DeviceToken = string.IsNullOrWhiteSpace(_token.Text)
                ? _existing.DeviceToken
                : _token.Text.Trim(),
            AllowedRoots = roots,
            AutoStartAgent = _autoAgent.Checked,
            AutoStartManager = _autoManager.Checked
        };

        var validation = AgentConfigurationValidator.Validate(config);
        if (!validation.IsValid)
        {
            MessageBox.Show(
                this,
                string.Join(Environment.NewLine, validation.Errors),
                "設定エラー",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }

        Result = config;
        DialogResult = DialogResult.OK;
    }
}
