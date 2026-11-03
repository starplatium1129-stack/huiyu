using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Media;

namespace Ayaki.Installer {
  // Shares the installer's actual XAML, theme, window chrome and motion lifecycle.
  internal sealed partial class InstallerWindow {
    private bool dataConfirmed;
    private string[] DataRoots {
      get { return new [] {
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "com.aics.studio"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "com.aics.studio")
      }; }
    }
    private void ConfigureUninstall() {
      View.Title = "绘遇 · 卸载";
      Get<TextBlock>("RailMode").Text = "卸载";
      AutomationProperties.SetName(Get<Button>("CloseButton"), "关闭卸载器");
      AutomationProperties.SetName(Get<Button>("ThemeButton"), "切换界面主题");
      AutomationProperties.SetName(directory, "应用位置");
      AutomationProperties.SetName(progressHost, "卸载正在进行");
      shortcut.Visibility = Visibility.Collapsed;
      browse.Visibility = Visibility.Collapsed;
      directory.IsReadOnly = true;
      Get<TextBlock>("ExistingText").Visibility = Visibility.Collapsed;
      Get<StackPanel>("UninstallDataPanel").Visibility = Visibility.Visible;
      UninstallReadyCopy();
      SetAction("卸载绘遇"); main.IsEnabled = true;
      Get<CheckBox>("DeleteDataCheck").Checked += delegate { UpdateDataChoice(); };
      Get<CheckBox>("DeleteDataCheck").Unchecked += delegate { UpdateDataChoice(); };
      Get<Button>("KeepDataButton").Click += delegate {
        dataConfirmed = false; Get<CheckBox>("DeleteDataCheck").IsChecked = false;
        Get<StackPanel>("UninstallConfirmPanel").Visibility = Visibility.Collapsed;
        Get<StackPanel>("ConfigurationPanel").Visibility = Visibility.Visible;
        Get<StackPanel>("UninstallDataPanel").Visibility = Visibility.Visible;
        UninstallReadyCopy();
        SetAction("卸载绘遇"); main.IsDefault = true; main.Focus();
      };
    }
    private void UninstallReadyCopy() {
      Get<TextBlock>("StepText").Text = "卸载选项";
      Get<TextBlock>("HeroTitle").Text = "卸载绘遇";
      Get<TextBlock>("HeroSubtitle").Text = "移除应用程序与快捷方式。你的创作，默认留在原处。";
      status.Text = "应用位置";
      space.Text = "清理个人数据为可选项，继续前会再次确认。";
      Get<TextBlock>("Footnote").Text = options.Preview ? "界面预览 · 不会卸载或删除数据" : "默认保留作品、个人设置与已导入资源";
    }
    private void UpdateDataChoice() {
      bool remove = Get<CheckBox>("DeleteDataCheck").IsChecked == true;
      dataConfirmed = false;
      Get<TextBlock>("DataTitle").Text = remove ? "你选择了清理个人数据" : "你的创作，默认保留";
      Get<TextBlock>("DataDescription").Text = remove
        ? "此账户应用数据目录内的作品、设置与资源也将删除。下一步确认具体目录。"
        : "作品、个人设置与已导入资源不会删除。重新安装后可继续使用。";
    }
    private void ConfirmDataChoice() {
      Get<TextBlock>("StepText").Text = "最后确认";
      Get<TextBlock>("HeroTitle").Text = "确认清理个人数据";
      Get<TextBlock>("HeroSubtitle").Text = "卸载绘遇，并删除此账户应用数据目录中的内容。";
      status.Text = "将清理的目录";
      space.Text = "想保留作品？选择返回，取消清理选项。";
      Get<TextBlock>("Footnote").Text = options.Preview ? "界面预览 · 不会卸载或删除数据" : "清理操作无法通过绘遇撤销";
      Get<StackPanel>("ConfigurationPanel").Visibility = Visibility.Collapsed;
      Get<StackPanel>("UninstallDataPanel").Visibility = Visibility.Collapsed;
      Get<StackPanel>("UninstallConfirmPanel").Visibility = Visibility.Visible;
      Get<TextBox>("DataPaths").Text = String.Join(Environment.NewLine + Environment.NewLine, DataRoots);
      SetAction("确认清理并卸载");
      main.IsDefault = false;
      Get<Button>("KeepDataButton").Focus();
      dataConfirmed = true;
    }
    private void UninstallProgress() {
      Get<StackPanel>("ConfigurationPanel").Visibility = Visibility.Collapsed;
      Get<StackPanel>("UninstallDataPanel").Visibility = Visibility.Collapsed;
      Get<StackPanel>("UninstallConfirmPanel").Visibility = Visibility.Collapsed;
      Get<TextBlock>("StepText").Text = "正在卸载";
      Get<TextBlock>("HeroTitle").Text = "正在收好画室";
      Get<TextBlock>("HeroSubtitle").Text = "正在移除应用程序与快捷方式，请稍候。";
      status.Text = "卸载进行中";
      space.Text = Get<CheckBox>("DeleteDataCheck").IsChecked == true
        ? "将按你的选择清理账户数据。完成前请不要关闭计算机。"
        : "作品、个人设置与已导入资源将保留。";
      Get<TextBlock>("Footnote").Text = options.Preview ? "界面预览 · 不会卸载或删除数据" : "卸载期间可最小化窗口";
      message.Visibility = Visibility.Collapsed;
      progressHost.Visibility = Visibility.Visible; Indeterminate();
      SetAction("正在卸载…"); main.IsEnabled = false;
    }
    private async Task BeginUninstall() {
      if (busy) return;
      if (complete) { View.Close(); return; }
      bool removeData = Get<CheckBox>("DeleteDataCheck").IsChecked == true;
      if (removeData && !dataConfirmed) { ConfirmDataChoice(); return; }
      if (options.Preview) { PreviewUninstall("installing"); ShowMessage("这是界面预览，没有执行卸载或清理。", false); return; }
      busy = true; installing = true; UninstallProgress();
      elapsed.Restart(); timer.Start();
      Get<TextBlock>("ElapsedText").Text = "已用时 00:00";
      Get<TextBlock>("ElapsedText").Visibility = Visibility.Visible;
      try {
        string target = InstallEngine.NormalizeDirectory(options.Directory);
        // The enclosing NSIS process makes this private copy of its own running
        // uninstaller. _?= prevents another detached self-copy, so exit means done.
        string core = Path.GetFullPath(options.CorePath);
        string own = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
        if (!String.Equals(Path.GetDirectoryName(core), own, StringComparison.OrdinalIgnoreCase)
          || !String.Equals(Path.GetFileName(core), "UninstallCore.exe", StringComparison.OrdinalIgnoreCase)
          || !File.Exists(core)) throw new IOException("卸载核心不可用，请重新打开已安装的卸载器。");
        int code = await Task.Run(() => {
          using (Process process = Process.Start(new ProcessStartInfo(core,
            "/S" + (removeData ? " /HUIYU_DELETE_DATA" : "") + " _?=" + target) {
              UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = own
            })) { process.WaitForExit(); return process.ExitCode; }
        });
        if (code == 1618 || code == 1603) throw new IOException("绘遇或资源任务仍在运行，或无法确认已退出。请保存工作，从托盘完全退出绘遇后重试。");
        if (code != 0) throw new IOException("卸载未完成（代码 " + code + "）。请检查目录权限，退出绘遇后重试。");
        if (File.Exists(Path.Combine(target, "ai-cg-studio-desktop.exe"))) throw new IOException("应用程序文件仍被占用。请退出绘遇后重试。");
        if (removeData) foreach (string root in DataRoots)
          if (Directory.Exists(root)) throw new IOException("程序已移除，但部分个人数据未清理完成。请检查目录权限或占用后重试。目录：" + root);
        UninstallComplete();
      } catch (Exception ex) { UninstallError(ex.Message); }
    }
    private void StopUninstallProgress() {
      busy = false; installing = false; timer.Stop(); elapsed.Stop();
      sweep.BeginAnimation(TranslateTransform.XProperty, null); sweepBar.Visibility = Visibility.Collapsed;
    }
    private void UninstallComplete() {
      StopUninstallProgress(); complete = true; ExitCode = 0;
      Get<TextBlock>("StepText").Text = "卸载完成";
      Get<TextBlock>("HeroTitle").Text = "期待下一次相遇";
      Get<TextBlock>("HeroSubtitle").Text = "绘遇已卸载，应用程序与快捷方式已移除。";
      status.Text = "已完成"; status.SetResourceReference(TextBlock.ForegroundProperty, "Success");
      space.Text = Get<CheckBox>("DeleteDataCheck").IsChecked == true
        ? "已按你的选择清理账户数据。保存在其他位置的文件不受影响。"
        : "作品、个人设置与已导入资源已保留。以后重新安装绘遇，可继续使用。";
      Get<TextBlock>("Footnote").Text = options.Preview ? "界面预览 · 未执行卸载" : "感谢这段相伴";
      progressHost.Visibility = Visibility.Visible; scale.ScaleX = 1;
      SetAction("完成"); main.IsEnabled = true; main.IsDefault = true;
    }
    private void UninstallError(string text) {
      StopUninstallProgress(); dataConfirmed = false;
      Get<TextBlock>("StepText").Text = "需要处理";
      Get<TextBlock>("HeroTitle").Text = "卸载尚未完成";
      Get<TextBlock>("HeroSubtitle").Text = "处理下方提示后，可以重新尝试。";
      status.Text = "应用位置";
      Get<StackPanel>("ConfigurationPanel").Visibility = Visibility.Visible;
      Get<StackPanel>("UninstallDataPanel").Visibility = Visibility.Visible;
      progressHost.Visibility = Visibility.Collapsed;
      space.Text = "保留当前卸载选项；清理个人数据仍需再次确认。";
      Get<TextBlock>("Footnote").Text = options.Preview ? "界面预览 · 不会卸载或删除数据" : "处理提示后可重试，也可关闭窗口";
      SetAction("重新尝试"); main.IsEnabled = true; main.IsDefault = true;
      ShowMessage(text, true);
    }
    private void PreviewUninstall(string state) {
      if (state == "confirm") { Get<CheckBox>("DeleteDataCheck").IsChecked = true; ConfirmDataChoice(); }
      else if (state == "installing") { UninstallProgress(); sweep.BeginAnimation(TranslateTransform.XProperty, null); sweep.X = 100; }
      else if (state == "done") { UninstallProgress(); UninstallComplete(); }
      else if (state == "error") { UninstallError("绘遇仍在运行。请保存工作，从系统托盘完全退出绘遇后重试。"); }
    }
  }
}
