using System.Security.Cryptography;
using System.Text;

namespace PcAgentManager.Configuration;

public sealed class SecureTokenStore
{
    private readonly string _path;

    public SecureTokenStore(string path)
    {
        _path = path;
    }

    public void Save(string token)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(token);
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);

        var clear = Encoding.UTF8.GetBytes(token);
        var protectedBytes = ProtectedData.Protect(
            clear,
            optionalEntropy: null,
            DataProtectionScope.CurrentUser);

        var temp = _path + ".tmp";
        File.WriteAllBytes(temp, protectedBytes);
        File.Move(temp, _path, overwrite: true);
        CryptographicOperations.ZeroMemory(clear);
    }

    public string Load()
    {
        if (!File.Exists(_path))
        {
            return "";
        }

        var protectedBytes = File.ReadAllBytes(_path);
        var clear = ProtectedData.Unprotect(
            protectedBytes,
            optionalEntropy: null,
            DataProtectionScope.CurrentUser);

        try
        {
            return Encoding.UTF8.GetString(clear);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(clear);
        }
    }
}
