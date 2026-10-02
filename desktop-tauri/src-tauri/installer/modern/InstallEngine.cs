using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace Ayaki.Installer {
  internal sealed class InstallOptions {
    public bool Preview, Silent, Passive, SelfTest, Launch, Update, NoNativeShortcuts, Shortcut = true;
    public string Theme = "dark", State = "ready", Capture = "", Directory = "";
    public int Dpi = 96;
    public static InstallOptions Parse(string[] args) {
      var o = new InstallOptions();
      for (int i = 0; i < args.Length; i++) {
        string a = args[i];
        if (a.Equals("/S", StringComparison.OrdinalIgnoreCase)) o.Silent = true;
        else if (a.Equals("/P", StringComparison.OrdinalIgnoreCase)) o.Passive = true;
        else if (a.Equals("/UPDATE", StringComparison.OrdinalIgnoreCase)) o.Update = true;
        else if (a.Equals("/R", StringComparison.OrdinalIgnoreCase)) o.Launch = true;
        else if (a.Equals("/NS", StringComparison.OrdinalIgnoreCase)) { o.Shortcut = false; o.NoNativeShortcuts = true; }
        else if (a == "--preview") o.Preview = true;
        else if (a == "--self-test") o.SelfTest = true;
        else if (a.StartsWith("--theme=")) o.Theme = a.Substring(8);
        else if (a.StartsWith("--state=")) o.State = a.Substring(8);
        else if (a.StartsWith("--capture=")) { o.Capture = a.Substring(10); o.Preview = true; }
        else if (a.StartsWith("--dpi=")) { int d; if (Int32.TryParse(a.Substring(6), out d) && d >= 96 && d <= 240) o.Dpi = d; }
        else if (a.StartsWith("/D=", StringComparison.OrdinalIgnoreCase)) {
          o.Directory = String.Join(" ", args, i, args.Length - i).Substring(3).Trim('"'); break;
        }
      }
      if (PayloadInfo.PreviewBuild) o.Preview = true;
      return o;
    }
  }
  internal sealed class InstalledProduct {
    public string Directory, Version;
  }
  internal sealed class InstallProgress {
    public string Stage;
    public double Fraction;
    public InstallProgress(string stage, double fraction) { Stage = stage; Fraction = fraction; }
  }
  internal static class InstallEngine {
    public static InstalledProduct Existing() {
      foreach (RegistryView view in new [] { RegistryView.Registry64, RegistryView.Registry32 }) {
        using (RegistryKey root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view))
        using (RegistryKey key = root.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\AI-CG-Studio")) {
          if (key == null) continue;
          string location = Convert.ToString(key.GetValue("InstallLocation", key.GetValue("", ""))).Trim().Trim('"');
          if (String.IsNullOrWhiteSpace(location)) continue;
          try { return new InstalledProduct { Directory = NormalizeDirectory(location), Version = Convert.ToString(key.GetValue("DisplayVersion", "")) }; }
          catch (ArgumentException) { }
        }
      }
      return new InstalledProduct { Directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "AI-CG-Studio"), Version = "" };
    }
    public static string NormalizeDirectory(string value) {
      if (String.IsNullOrWhiteSpace(value)) throw new ArgumentException("请输入安装位置。");
      value = value.Trim();
      if (value.Length < 4 || !Char.IsLetter(value[0]) || value[1] != ':' || (value[2] != '\\' && value[2] != '/')) throw new ArgumentException("请选择本地磁盘中的完整路径。");
      if (value.IndexOfAny(new [] { '"', '<', '>', '|', '?', '*' }) >= 0) throw new ArgumentException("安装位置包含不可用的字符。");
      string full = Path.GetFullPath(value).TrimEnd('\\', '/');
      if (full.Length > 180) throw new ArgumentException("安装路径过长，请选择更短的位置。");
      string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows).TrimEnd('\\');
      string root = Path.GetPathRoot(full).TrimEnd('\\');
      if (String.Equals(full, root, StringComparison.OrdinalIgnoreCase) || String.Equals(full, windows, StringComparison.OrdinalIgnoreCase) || full.StartsWith(windows + "\\", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("请选择独立的应用文件夹，不要使用系统目录或磁盘根目录。");
      foreach (Environment.SpecialFolder folder in new [] { Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86, Environment.SpecialFolder.UserProfile, Environment.SpecialFolder.DesktopDirectory, Environment.SpecialFolder.MyDocuments }) {
        string protectedPath = Environment.GetFolderPath(folder).TrimEnd('\\');
        if (String.Equals(full, protectedPath, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("请在这个位置下创建独立的应用文件夹。");
      }
      return full;
    }
    public static long FreeSpace(string directory) {
      var drive = new DriveInfo(Path.GetPathRoot(directory));
      if (!drive.IsReady) throw new IOException("所选磁盘暂不可用。");
      return drive.AvailableFreeSpace;
    }
    public static string Size(long bytes) {
      return bytes >= 1024L * 1024 * 1024 ? (bytes / (1024d * 1024 * 1024)).ToString("0.0") + " GB" : Math.Ceiling(bytes / (1024d * 1024)).ToString("0") + " MB";
    }
    public static bool NewerInstalled() {
      Version current, target;
      return Version.TryParse(Existing().Version, out current) && Version.TryParse(PayloadInfo.Version, out target) && current > target;
    }
    public static string Hash(Stream stream) {
      using (SHA256 sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }
    public static string VerifyPayload() {
      using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream("Payload.exe")) {
        if (source == null || source.Length != PayloadInfo.Length || Hash(source) != PayloadInfo.Sha256) throw new IOException("安装包校验失败，请重新下载。");
      }
      return PayloadInfo.Sha256;
    }
    public static Task<int> Run(InstallOptions options, IProgress<InstallProgress> progress, CancellationToken cancellation) {
      return Task.Run(() => {
        if (options.Preview) throw new InvalidOperationException("预览模式不能安装应用。");
        if (NewerInstalled()) throw new InvalidOperationException("本机已有更高版本，请使用最新安装包。");
        string directory = NormalizeDirectory(String.IsNullOrEmpty(options.Directory) ? Existing().Directory : options.Directory);
        long free = FreeSpace(directory);
        bool sameDrive = String.Equals(Path.GetPathRoot(directory), Path.GetPathRoot(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase);
        long required = PayloadInfo.RequiredBytes + 64L * 1024 * 1024 + (sameDrive ? PayloadInfo.Length : 0);
        if (free < required || FreeSpace(Path.GetTempPath()) < PayloadInfo.Length + 32L * 1024 * 1024) throw new IOException("磁盘空间不足，请更换安装位置或释放一些空间后重试。");
        string ownedRoot = Path.Combine(Path.GetTempPath(), "AyakiInstaller");
        string temporary = Path.Combine(ownedRoot, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temporary);
        string payload = Path.Combine(temporary, "setup.exe");
        try {
          if (PayloadInfo.UpgradeOnly) {
            VerifyUpgrade(directory, temporary, cancellation);
            options.Update = true;
          }
          using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream("Payload.exe")) {
            if (source == null || source.Length != PayloadInfo.Length) throw new IOException("安装资源不完整，请重新下载。");
            using (var output = new FileStream(payload, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
              byte[] buffer = new byte[1024 * 1024]; int count; long written = 0;
              while ((count = source.Read(buffer, 0, buffer.Length)) > 0) {
                cancellation.ThrowIfCancellationRequested(); output.Write(buffer, 0, count); written += count;
                if (progress != null) progress.Report(new InstallProgress("prepare", (double)written / source.Length));
              }
            }
          }
          using (Stream check = File.OpenRead(payload)) if (Hash(check) != PayloadInfo.Sha256) throw new IOException("安装包校验失败，请重新下载。");
          cancellation.ThrowIfCancellationRequested();
          if (progress != null) progress.Report(new InstallProgress("install", 0));
          string arguments = "/S" + (options.Update ? " /UPDATE" : "") + (options.NoNativeShortcuts || !options.Shortcut ? " /NS" : "") + (options.Launch ? " /R" : "") + " /D=" + directory;
          using (Process process = Process.Start(new ProcessStartInfo(payload, arguments) { UseShellExecute = true, Verb = "runas" })) {
            if (process == null) throw new IOException("无法启动安装程序，请重试。");
            process.WaitForExit();
            if (process.ExitCode != 0) return process.ExitCode;
          }
          string app = Path.Combine(directory, "ai-cg-studio-desktop.exe");
          if (!File.Exists(app) || FileVersionInfo.GetVersionInfo(app).ProductVersion != PayloadInfo.Version) throw new IOException("安装结果未能确认，请重试或检查安装位置。");
          return 0;
        } finally {
          // Only remove the randomly created child of our own temporary root.
          if (Path.GetFullPath(temporary).StartsWith(Path.GetFullPath(ownedRoot) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) {
            try { Directory.Delete(temporary, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
          }
        }
      }, cancellation);
    }
    static void VerifyUpgrade(string directory, string temporary, CancellationToken cancellation) {
      string checker = Path.Combine(temporary, "upgrade-check.exe");
      using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream("UpgradeVerifier.exe")) {
        if (source == null) throw new IOException("升级包校验组件缺失，请重新下载完整安装包。");
        using (var output = new FileStream(checker, FileMode.CreateNew, FileAccess.Write, FileShare.None)) source.CopyTo(output);
      }
      using (var stream = File.OpenRead(checker)) if (Hash(stream) != PayloadInfo.UpgradeVerifierSha256) throw new IOException("升级包校验组件已损坏。");
      using (Process process = Process.Start(new ProcessStartInfo(checker, "\"" + directory + "\"") {
        UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
        RedirectStandardOutput = true, RedirectStandardError = true,
        StandardOutputEncoding = System.Text.Encoding.UTF8, StandardErrorEncoding = System.Text.Encoding.UTF8
      })) {
        if (process == null) throw new IOException("无法检查已有安装。");
        try {
          DateTime deadline = DateTime.UtcNow.AddSeconds(60);
          while (!process.WaitForExit(100)) {
            cancellation.ThrowIfCancellationRequested();
            if (DateTime.UtcNow > deadline) throw new IOException("基础素材检查超时，请重试或使用完整安装包。");
          }
          string message = process.StandardOutput.ReadToEnd().Trim();
          if (process.ExitCode != 0) throw new IOException(String.IsNullOrEmpty(message) ? "无法复用已有资源，请使用完整安装包。" : message);
        } finally { if (!process.HasExited) { process.Kill(); process.WaitForExit(2000); } }
      }
    }
  }
}
