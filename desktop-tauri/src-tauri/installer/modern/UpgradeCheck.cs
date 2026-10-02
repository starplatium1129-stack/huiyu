using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Diagnostics;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using Microsoft.Win32;

namespace Huiyu.Upgrade {
  [DataContract] public sealed class Asset {
    [DataMember] public string path;
    [DataMember] public long bytes;
    [DataMember] public string sha256;
  }
  [DataContract] public sealed class Requirements {
    [DataMember] public int schemaVersion;
    [DataMember] public string version;
    [DataMember] public Asset[] assets;
  }
  public static class UpgradeCheck {
    const string ProductKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\AI-CG-Studio";
    const string WebViewKey = @"Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    const string FullPackage = "请下载本版本的完整安装包进行安装或修复。";

    public static Requirements Read(Stream stream) {
      var value = (Requirements)new DataContractJsonSerializer(typeof(Requirements)).ReadObject(stream);
      Version parsed;
      if (value.schemaVersion != 1 || !Version.TryParse(value.version, out parsed) || value.assets == null || value.assets.Length == 0 || value.assets.Length > 10000)
        throw new IOException("升级包资源清单无效。");
      return value;
    }
    static string Normal(string directory) {
      string full = Path.GetFullPath(directory).TrimEnd('\\', '/');
      if (full.Length < 4 || full[1] != ':' || full.StartsWith(@"\\")) throw new IOException("升级位置不是本地安装目录。");
      return full;
    }
    static void Ordinary(string file) {
      string current = file;
      while (!String.IsNullOrEmpty(current)) {
        if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new IOException("安装目录包含链接，无法安全复用资源。");
        current = Path.GetDirectoryName(current);
      }
    }
    public static void Verify(string directory, string registeredDirectory, string registeredVersion, bool webViewPresent, Requirements requirements) {
      string root = Normal(directory);
      if (String.IsNullOrEmpty(registeredDirectory) || !String.Equals(root, Normal(registeredDirectory), StringComparison.OrdinalIgnoreCase))
        throw new IOException("轻量升级包需要已有的绘遇安装。" + FullPackage);
      Ordinary(root);
      string executable = Path.Combine(root, "ai-cg-studio-desktop.exe");
      if (!File.Exists(executable)) throw new IOException("原程序不完整。" + FullPackage);
      Ordinary(executable);
      Version installed, target;
      if (!Version.TryParse(registeredVersion, out installed) || !Version.TryParse(requirements.version, out target) || installed > target)
        throw new IOException("已有安装版本不支持本次升级。" + FullPackage);
      if (FileVersionInfo.GetVersionInfo(executable).ProductVersion != registeredVersion)
        throw new IOException("已有程序与安装登记不一致。" + FullPackage);
      if (!webViewPresent) throw new IOException("缺少 WebView2 运行环境。" + FullPackage);
      var seen = new System.Collections.Generic.HashSet<string>(StringComparer.OrdinalIgnoreCase);
      foreach (var asset in requirements.assets) {
        if (asset == null || String.IsNullOrEmpty(asset.path) || !seen.Add(asset.path) || asset.bytes < 0 || asset.sha256 == null || !System.Text.RegularExpressions.Regex.IsMatch(asset.sha256, "^[a-f0-9]{64}$"))
          throw new IOException("升级包资源条目无效。");
        var parts = asset.path.Split('/');
        if (parts.Length < 4 || parts[0] != "gateway" || parts[1] != "assets" || !new [] { "characters", "live2d", "chibi", "dual-poses", "particles" }.Contains(parts[2]) ||
            parts.Any(p => String.IsNullOrEmpty(p) || p == "." || p == ".." || p.IndexOfAny(new [] { ':', '\\', '\0', '\r', '\n' }) >= 0 || p.EndsWith(".") || p.EndsWith(" ")))
          throw new IOException("升级包资源路径无效。");
        string file = Path.GetFullPath(Path.Combine(root, asset.path.Replace('/', Path.DirectorySeparatorChar)));
        if (!file.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new IOException("升级包资源路径越界。");
        if (!File.Exists(file)) throw new IOException("基础素材缺失。" + FullPackage);
        Ordinary(file);
        using (var stream = File.OpenRead(file)) {
          if (stream.Length != asset.bytes) throw new IOException("基础素材版本不同。" + FullPackage);
          using (var sha = SHA256.Create()) {
            string hash = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
            if (hash != asset.sha256) throw new IOException("基础素材已变化或损坏。" + FullPackage);
          }
        }
      }
    }
    static bool HasWebView() {
      foreach (var hive in new [] { RegistryHive.LocalMachine, RegistryHive.CurrentUser })
        foreach (var view in new [] { RegistryView.Registry64, RegistryView.Registry32 })
          using (var root = RegistryKey.OpenBaseKey(hive, view))
          using (var key = root.OpenSubKey(WebViewKey)) {
            Version runtime;
            if (key != null && Version.TryParse(Convert.ToString(key.GetValue("pv", "")), out runtime) && runtime.Major > 0) return true;
          }
      return false;
    }
    public static int Main(string[] args) {
      try {
        if (args.Length != 1) throw new IOException("缺少升级安装位置。");
        Requirements requirements;
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("UpgradeRequirements.json")) {
          if (stream == null) throw new IOException("升级资源清单缺失。");
          requirements = Read(stream);
        }
        string directory = null, version = null;
        foreach (var view in new [] { RegistryView.Registry64, RegistryView.Registry32 })
          using (var registry = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view))
          using (var key = registry.OpenSubKey(ProductKey)) {
            if (key == null) continue;
            string found = Convert.ToString(key.GetValue("InstallLocation", "")).Trim().Trim('"');
            if (String.IsNullOrEmpty(found) || !String.Equals(Normal(found), Normal(args[0]), StringComparison.OrdinalIgnoreCase)) continue;
            string foundVersion = Convert.ToString(key.GetValue("DisplayVersion", ""));
            if (directory != null && version != foundVersion) throw new IOException("安装登记版本冲突。" + FullPackage);
            directory = found; version = foundVersion;
          }
        Verify(args[0], directory, version, HasWebView(), requirements);
        return 0;
      } catch (Exception error) {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        Console.WriteLine(error.Message);
        return 1603;
      }
    }
  }
}
