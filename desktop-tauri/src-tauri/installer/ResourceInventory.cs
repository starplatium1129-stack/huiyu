using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace Huiyu.Installer {
  [DataContract] public sealed class ResourceFile {
    [DataMember] public string path;
    [DataMember] public long bytes;
    [DataMember] public string sha256;
  }
  [DataContract] public sealed class ResourceInventory {
    [DataMember] public int schemaVersion;
    [DataMember] public string kind;
    [DataMember] public ResourceFile[] files;
  }

  // Both the ledger and embedded migration baseline contain packaged identities.
  // Unknown or locally modified files never become eligible by scanning.
  public static class ResourceCleanup {
    const string Ledger = ".huiyu-installed-resources.json";
    const string Current = "gateway/bundled-resource-inventory.json";
    static readonly HashSet<string> ManagedDirectories = new HashSet<string>(
      new [] { "assets", "data", "dist", "docs", "tools", "scripts", "native", "native-licenses" }, StringComparer.OrdinalIgnoreCase);
    static readonly Regex Hash = new Regex("^[a-f0-9]{64}$", RegexOptions.CultureInvariant);

    static bool Managed(string relative) {
      if (String.IsNullOrEmpty(relative) || relative.IndexOf('\\') >= 0) return false;
      string[] parts = relative.Split('/');
      if (parts.Length < 3 || !parts[0].Equals("gateway", StringComparison.OrdinalIgnoreCase) || !ManagedDirectories.Contains(parts[1])) return false;
      return parts.All(p => !String.IsNullOrEmpty(p) && p != "." && p != ".." && !p.EndsWith(".") && !p.EndsWith(" ")
        && p.IndexOfAny(Path.GetInvalidFileNameChars()) < 0 && !p.Any(Char.IsControl));
    }
    static void Ordinary(string file) {
      for (string current = file; !String.IsNullOrEmpty(current); current = Path.GetDirectoryName(current)) {
        if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new IOException("安装路径包含链接：" + current);
      }
    }
    static DataContractJsonSerializer Serializer() {
      return new DataContractJsonSerializer(typeof(ResourceInventory), new DataContractJsonSerializerSettings { MaxItemsInObjectGraph = 1000000 });
    }
    static ResourceInventory Read(string file, bool deployment, string expectedHash = null) {
      Ordinary(file);
      ResourceInventory value;
      using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read)) {
        if (expectedHash != null) {
          using (var sha = SHA256.Create()) {
            string hash = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
            if (!Hash.IsMatch(expectedHash) || hash != expectedHash) throw new IOException("旧安装清单已变化：" + file);
            stream.Position = 0;
          }
        }
        value = (ResourceInventory)Serializer().ReadObject(stream);
      }
      Validate(value, deployment, file);
      return value;
    }
    static void Validate(ResourceInventory value, bool deployment, string file) {
      if (value == null || value.schemaVersion != 1 || value.files == null || value.files.Length > 100000
        || value.kind != (deployment ? "desktop-installer-deployment" : "huiyu-bundled-resources"))
        throw new IOException("资源清单格式无效：" + file);
      foreach (var item in value.files) {
        if (item == null || String.IsNullOrEmpty(item.path) || item.bytes < 0 || item.sha256 == null || !Hash.IsMatch(item.sha256))
          throw new IOException("资源清单包含无效条目：" + file);
      }
    }
    static ResourceInventory Legacy() {
      // Embedded at build time: standalone installers can migrate versions that
      // predate the on-disk ledger, without trusting a downloaded/local manifest.
      using (var source = Assembly.GetExecutingAssembly().GetManifestResourceStream("LegacyResources.gz")) {
        if (source == null) throw new IOException("旧版资源迁移清单缺失。");
        using (var stream = new GZipStream(source, CompressionMode.Decompress)) {
          var value = (ResourceInventory)Serializer().ReadObject(stream);
          Validate(value, false, "LegacyResources.gz");
          if (value.files.Any(item => !Managed(item.path))) throw new IOException("旧版资源迁移清单包含非应用路径。");
          return value;
        }
      }
    }
    static string Target(string root, string relative) {
      if (!Managed(relative)) throw new IOException("资源路径无效：" + relative);
      string target = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
      if (!target.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new IOException("资源路径越界。");
      return target;
    }
    static bool SameFile(string file, IEnumerable<ResourceFile> variants) {
      Ordinary(file);
      using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read)) {
        var candidates = variants.Where(item => item.bytes == stream.Length).ToArray();
        if (candidates.Length == 0) return false;
        using (var sha = SHA256.Create()) {
          string hash = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
          return candidates.Any(item => item.sha256 == hash);
        }
      }
    }
    static void Save(string root, IEnumerable<ResourceFile> files) {
      string ledger = Path.Combine(root, Ledger);
      if (File.Exists(ledger)) Ordinary(ledger);
      string temporary = Path.Combine(root, Ledger + "." + Guid.NewGuid().ToString("N") + ".tmp");
      try {
        using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
          Serializer().WriteObject(stream, new ResourceInventory { schemaVersion = 1, kind = "huiyu-bundled-resources", files = files.ToArray() });
          stream.Flush(true);
        }
        if (File.Exists(ledger)) File.Replace(temporary, ledger, null);
        else File.Move(temporary, ledger);
      } finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    static void RemoveEmptyParents(string root, string file) {
      string gateway = Path.Combine(root, "gateway");
      for (string directory = Path.GetDirectoryName(file); directory != null && directory.StartsWith(gateway + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase); directory = Path.GetDirectoryName(directory)) {
        try { Ordinary(directory); Directory.Delete(directory, false); }
        catch (IOException) { break; }
        catch (UnauthorizedAccessException) { break; }
      }
    }
    public static int Main(string[] args) {
      try {
        if (args.Length < 1 || args.Length % 2 != 1) throw new IOException("缺少安装目录或旧清单身份。");
        string root = Path.GetFullPath(args[0]).TrimEnd('\\', '/');
        if (root.Length < 4 || root[1] != ':' || root.StartsWith(@"\\")) throw new IOException("安装位置不是本地目录。");
        Ordinary(root);
        var current = Read(Path.Combine(root, Current.Replace('/', Path.DirectorySeparatorChar)), false);
        var present = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in current.files) {
          if (!Managed(item.path) && !item.path.StartsWith("gateway/", StringComparison.OrdinalIgnoreCase)) throw new IOException("当前资源路径无效。");
          if (!present.Add(item.path)) throw new IOException("当前资源清单包含重复路径。");
        }
        var previous = new List<ResourceFile>(Legacy().files);
        string ledger = Path.Combine(root, Ledger);
        if (File.Exists(ledger)) previous.AddRange(Read(ledger, false).files);
        for (int i = 1; i < args.Length; i += 2) previous.AddRange(Read(Path.GetFullPath(args[i]), true, args[i + 1]).files);
        var retained = new List<ResourceFile>(current.files);
        int removed = 0, preserved = 0;
        long bytes = 0;
        foreach (var group in previous.Where(item => Managed(item.path) && !present.Contains(item.path)).GroupBy(item => item.path, StringComparer.OrdinalIgnoreCase)) {
          string file = Target(root, group.Key);
          if (!File.Exists(file)) continue;
          bool unchanged;
          try { unchanged = SameFile(file, group); }
          catch (IOException) { unchanged = false; }
          catch (UnauthorizedAccessException) { unchanged = false; }
          if (!unchanged) { retained.AddRange(group); preserved++; continue; }
          Ordinary(file);
          long size = new FileInfo(file).Length;
          File.Delete(file);
          removed++; bytes += size;
          RemoveEmptyParents(root, file);
        }
        Save(root, retained.GroupBy(item => item.path + "\n" + item.sha256, StringComparer.OrdinalIgnoreCase).Select(group => group.First()));
        Console.WriteLine("已清理旧版随包文件 {0} 个（{1} 字节）；保留已更改或无法核验的文件 {2} 个。", removed, bytes, preserved);
        return 0;
      } catch (Exception error) {
        Console.Error.WriteLine("旧资源清理未完成：" + error.Message);
        return 1604;
      }
    }
  }
}
