using System;
using System.IO;
using System.Threading;
using System.Windows;

namespace Ayaki.Installer {
  internal static class Program {
    [STAThread]
    public static int Main(string[] args) {
      try { Console.OutputEncoding = new System.Text.UTF8Encoding(false); } catch { }
      InstallOptions options = InstallOptions.Parse(args);
      try {
        if (options.Silent && !options.Preview) return InstallEngine.Run(options, null, CancellationToken.None).GetAwaiter().GetResult();
        var app = new Application();
        var window = new InstallerWindow(options);
        if (!String.IsNullOrEmpty(options.Capture)) { window.Capture(options.Capture, options.Dpi); return 0; }
        app.Run(window.View);
        return window.ExitCode;
      } catch (Exception ex) {
        if (!options.Silent && String.IsNullOrEmpty(options.Capture)) MessageBox.Show(ex.Message, "绘遇", MessageBoxButton.OK, MessageBoxImage.Information);
        Console.Error.WriteLine(ex.ToString());
        return 1;
      }
    }
  }
}
