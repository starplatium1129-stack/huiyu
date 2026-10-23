using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;

namespace Ayaki.Installer {
  internal sealed class InstallerWindow {
    public readonly Window View;
    public int ExitCode = 1602;
    private readonly InstallOptions options;
    private readonly InstalledProduct installed;
    private CancellationTokenSource cancellation;
    private bool busy, installing, complete, closeRequested, light;
    private readonly Button main, browse;
    private readonly TextBox directory;
    private readonly CheckBox shortcut;
    private readonly TextBlock status, message, space, action;
    private readonly Grid progressHost;
    private readonly ScaleTransform scale;
    private readonly TranslateTransform sweep;
    private readonly System.Windows.Shapes.Rectangle sweepBar;
    private readonly Stopwatch elapsed = new Stopwatch();
    private readonly System.Windows.Threading.DispatcherTimer timer = new System.Windows.Threading.DispatcherTimer();

    public InstallerWindow(InstallOptions settings) {
      options = settings; installed = InstallEngine.Existing();
      using (Stream xaml = Assembly.GetExecutingAssembly().GetManifestResourceStream("Installer.xaml")) View = (Window)XamlReader.Load(xaml);
      main = Get<Button>("MainButton"); browse = Get<Button>("BrowseButton"); directory = Get<TextBox>("PathBox");
      shortcut = Get<CheckBox>("ShortcutCheck"); status = Get<TextBlock>("StatusText"); message = Get<TextBlock>("MessageText");
      space = Get<TextBlock>("SpaceText"); action = Get<TextBlock>("MainAction"); progressHost = Get<Grid>("ProgressHost");
      scale = Get<ScaleTransform>("ProgressScale"); sweep = Get<TranslateTransform>("ProgressTranslate");
      sweepBar = Get<System.Windows.Shapes.Rectangle>("ProgressSweep");
      using (Stream art = Assembly.GetExecutingAssembly().GetManifestResourceStream("Mascot.png")) {
        var image = new BitmapImage(); image.BeginInit(); image.CacheOption = BitmapCacheOption.OnLoad; image.StreamSource = art; image.EndInit(); image.Freeze(); Get<Image>("HeroImage").Source = image;
      }
      directory.Text = String.IsNullOrEmpty(options.Directory) ? installed.Directory : options.Directory;
      shortcut.IsChecked = options.Shortcut;
      if (options.Update) shortcut.Visibility = Visibility.Collapsed;
      Get<TextBlock>("VersionText").Text = "V" + PayloadInfo.Version + "  ·  WINDOWS x64";
      Get<TextBlock>("ExistingText").Text = String.IsNullOrEmpty(installed.Version) ? "" : "已安装 " + installed.Version;
      SetAction(String.IsNullOrEmpty(installed.Version) ? "安装绘遇" : installed.Version == PayloadInfo.Version ? "重新安装" : "更新绘遇");
      if (PayloadInfo.UpgradeOnly) {
        options.Update = true;
        View.Title = "绘遇 · 轻量升级";
        status.Text = "当前安装位置";
        shortcut.Visibility = Visibility.Collapsed;
        directory.IsReadOnly = true;
        browse.Visibility = Visibility.Collapsed;
        Get<TextBlock>("HeroTitle").Text = "升级绘遇";
        Get<TextBlock>("HeroSubtitle").Text = "沿用已有素材，让画室保持最新。";
        SetAction("升级绘遇");
      } else {
        Get<TextBlock>("HeroSubtitle").Text = "一次安装，打开你的私人画室。生成模型在应用内按需准备。";
      }
      if (options.Preview) Get<TextBlock>("Footnote").Text = "界面预览 · 不会安装或修改现有软件";
      ApplyTheme(options.Theme == "light");
      RefreshSpace();
      main.Click += async delegate { if (complete) Launch(); else await BeginInstall(); };
      browse.Click += delegate {
        try { string selected = FolderPicker.Pick(new WindowInteropHelper(View).Handle); if (selected != null) directory.Text = String.Equals(Path.GetFileName(selected.TrimEnd('\\')), "AI-CG-Studio", StringComparison.OrdinalIgnoreCase) ? selected : Path.Combine(selected, "AI-CG-Studio"); }
        catch { ShowMessage("文件夹选择器暂不可用，也可以直接输入安装位置。", false); }
      };
      directory.TextChanged += delegate { RefreshSpace(); };
      Get<Button>("ThemeButton").Click += delegate { ApplyTheme(!light); };
      Get<Button>("MinimizeButton").Click += delegate { View.WindowState = WindowState.Minimized; };
      Get<Button>("CloseButton").Click += delegate { View.Close(); };
      Get<Button>("CancelButton").Click += delegate {
        if (cancellation == null || installing) return;
        cancellation.Cancel(); Get<Button>("CancelButton").IsEnabled = false; status.Text = "正在取消准备…";
      };
      timer.Interval = TimeSpan.FromSeconds(1);
      timer.Tick += delegate { Get<TextBlock>("ElapsedText").Text = "已用时 " + elapsed.Elapsed.ToString(@"mm\:ss"); };
      View.Closing += Closing;
      View.Closed += delegate { timer.Stop(); sweep.BeginAnimation(TranslateTransform.XProperty, null); };
      View.Loaded += async delegate {
        if (options.Passive && !options.Preview) await BeginInstall();
        else if (options.Preview) SetPreview(options.State);
      };
      View.MinWidth = Math.Min(720, SystemParameters.WorkArea.Width - 24);
      View.MinHeight = Math.Min(460, SystemParameters.WorkArea.Height - 24);
      View.Width = Math.Min(900, SystemParameters.WorkArea.Width - 24);
      View.Height = Math.Min(570, SystemParameters.WorkArea.Height - 24);
    }
    private T Get<T>(string name) where T : class { return (T)View.FindName(name); }
    private static Brush Color(string hex) { var brush = (SolidColorBrush)new BrushConverter().ConvertFromString(hex); brush.Freeze(); return brush; }
    private void ApplyTheme(bool value) {
      light = value;
      string[] names = { "Surface", "Card", "Line", "Text", "Muted", "Disabled", "DisabledText", "Error", "Success" };
      string[] colors = value
        ? new [] { "#FFF8F4", "#FFFFFF", "#B7BEC7", "#211C30", "#536173", "#E5E7EA", "#526173", "#A32642", "#236A50" }
        : new [] { "#151C24", "#1E2935", "#334354", "#EDF3FA", "#BDCBD8", "#27374A", "#A6B3C0", "#FFBBC9", "#A8D8C6" };
      for (int i = 0; i < names.Length; i++) View.Resources[names[i]] = Color(colors[i]);
      View.Resources["ProgressColor"] = Color(value ? "#92365F" : "#F2A8BE");
      View.Resources["ControlLine"] = Color(value ? "#7B899A" : "#657D96");
      Get<Button>("ThemeButton").Content = value ? "切换深色" : "切换浅色";
    }
    private void RefreshSpace() {
      if (busy || complete) return;
      try {
        string path = InstallEngine.NormalizeDirectory(directory.Text);
        long free = InstallEngine.FreeSpace(path);
        space.Text = "所需空间 " + InstallEngine.Size(PayloadInfo.RequiredBytes) + "   ·   可用 " + InstallEngine.Size(free);
        main.IsEnabled = free >= PayloadInfo.RequiredBytes && !InstallEngine.NewerInstalled();
        if (InstallEngine.NewerInstalled()) ShowMessage("本机已有更高版本，请使用最新安装包。", true);
        else message.Visibility = Visibility.Collapsed;
      } catch (Exception ex) {
        space.Text = ex.Message;
        main.IsEnabled = false;
      }
    }
    private void ShowMessage(string text, bool error) {
      message.SetResourceReference(TextBlock.ForegroundProperty, error ? "Error" : "Muted");
      message.Text = text; message.Visibility = Visibility.Visible;
    }
    private void Progress(InstallProgress value) {
      Get<TextBlock>("ExistingText").Visibility = Visibility.Collapsed;
      Get<StackPanel>("ConfigurationPanel").Visibility = Visibility.Collapsed;
      Get<StackPanel>("StagePanel").Visibility = Visibility.Visible;
      Get<TextBlock>("HeroTitle").Text = "正在准备你的画室";
      Get<TextBlock>("HeroSubtitle").Text = "作品与个人设置会保留，完成后即可进入绘遇。";
      progressHost.Visibility = Visibility.Visible;
      int active = value.Stage == "verify" ? 2 : value.Stage == "install" ? 1 : 0;
      string[] stages = { "PrepareStage", "InstallStage", "VerifyStage" };
      string[] labels = { "准备并校验安装资源", "安装应用与运行环境", "确认安装结果" };
      for (int i = 0; i < stages.Length; i++) {
        TextBlock item = Get<TextBlock>(stages[i]);
        item.Text = (i < active ? "已完成   " : (i + 1) + "   ") + labels[i];
        item.FontWeight = i == active ? FontWeights.SemiBold : FontWeights.Normal;
        item.SetResourceReference(TextBlock.ForegroundProperty, i < active ? "Success" : i == active ? "Text" : "Muted");
      }
      Get<TextBlock>("StepText").Text = "安装中";
      Get<Button>("CancelButton").Visibility = active == 0 ? Visibility.Visible : Visibility.Collapsed;
      if (value.Stage == "prerequisites") {
        status.Text = "正在核对已有素材";
        space.Text = "检查完成后，将自动开始准备升级资源。";
        Indeterminate();
      } else if (value.Stage == "prepare") {
        sweep.BeginAnimation(TranslateTransform.XProperty, null); sweepBar.Visibility = Visibility.Collapsed;
        status.Text = "准备并校验资源  " + Math.Round(value.Fraction * 100) + "%";
        space.Text = InstallEngine.Size((long)(PayloadInfo.Length * value.Fraction)) + " / " + InstallEngine.Size(PayloadInfo.Length);
        scale.ScaleX = value.Fraction;
      } else {
        installing = true; status.Text = active == 2 ? "正在确认安装结果" : "正在安装应用";
        space.Text = active == 2 ? "核对应用文件与版本。" : "请在 Windows 提示时允许安装。安装期间可以最小化窗口。";
        Indeterminate();
      }
    }
    private void Indeterminate() {
      scale.ScaleX = 0; sweepBar.Visibility = Visibility.Visible;
      if (SystemParameters.ClientAreaAnimation) sweep.BeginAnimation(TranslateTransform.XProperty, new DoubleAnimation(-180, progressHost.ActualWidth + 180, TimeSpan.FromSeconds(1.8)) { RepeatBehavior = RepeatBehavior.Forever });
      else sweepBar.Visibility = Visibility.Collapsed;
    }
    private async Task BeginInstall() {
      if (busy) return;
      if (options.Preview) { SetPreview("installing"); ShowMessage("这是界面预览，没有执行安装。", false); return; }
      try { options.Directory = InstallEngine.NormalizeDirectory(directory.Text); }
      catch (Exception ex) { ShowMessage(ex.Message, true); return; }
      options.Shortcut = shortcut.IsChecked == true;
      closeRequested = false;
      busy = true; main.IsEnabled = false; browse.IsEnabled = false; directory.IsReadOnly = true; shortcut.IsEnabled = false;
      SetAction("正在安装…"); message.Visibility = Visibility.Collapsed;
      status.SetResourceReference(TextBlock.ForegroundProperty, "Text");
      elapsed.Restart(); timer.Start();
      Get<TextBlock>("ElapsedText").Text = "已用时 00:00"; Get<TextBlock>("ElapsedText").Visibility = Visibility.Visible;
      Get<Button>("CancelButton").IsEnabled = true;
      cancellation = new CancellationTokenSource();
      try {
        int code = await InstallEngine.Run(options, new System.Progress<InstallProgress>(Progress), cancellation.Token);
        if (code == 1618 || code == 1603) throw new IOException("绘遇或资源任务仍在运行，或无法确认程序已退出。请保存工作，从托盘菜单完全退出绘遇，等待资源任务结束，再点击重新尝试。");
        if (code != 0) throw new IOException("安装未完成（代码 " + code + "）。请确认已从托盘完全退出绘遇，再重试或检查安装位置。");
        SetComplete();
        if (options.Passive || closeRequested) View.Close();
      } catch (OperationCanceledException) {
        Reset("已取消准备，可随时重新开始。"); if (closeRequested) View.Close();
      } catch (Win32Exception ex) {
        Reset(ex.NativeErrorCode == 1223 ? "已取消管理员授权。点击重新尝试可继续安装。" : "无法开始安装，请重试。 " + ex.Message);
      } catch (Exception ex) { Reset(ex.Message); }
      finally { if (cancellation != null) cancellation.Dispose(); cancellation = null; }
    }
    private void SetComplete() {
      busy = false; installing = false; complete = true; ExitCode = 0;
      timer.Stop(); elapsed.Stop();
      Get<StackPanel>("ConfigurationPanel").Visibility = Visibility.Collapsed;
      Get<StackPanel>("StagePanel").Visibility = Visibility.Collapsed;
      Get<Button>("CancelButton").Visibility = Visibility.Collapsed;
      progressHost.Visibility = Visibility.Visible;
      sweep.BeginAnimation(TranslateTransform.XProperty, null); sweepBar.Visibility = Visibility.Collapsed; scale.ScaleX = 1;
      Get<TextBlock>("ExistingText").Text = "已安装 " + PayloadInfo.Version;
      Get<TextBlock>("ExistingText").Visibility = Visibility.Visible;
      Get<TextBlock>("StepText").Text = "一切就绪";
      status.Text = "安装完成"; status.SetResourceReference(TextBlock.ForegroundProperty, "Success");
      Get<TextBlock>("HeroTitle").Text = "绘遇已就绪";
      Get<TextBlock>("HeroSubtitle").Text = "打开画室，继续你的故事。首次使用可在应用内准备绘图和聊天环境。";
      space.Text = "已安装至 " + directory.Text;
      if (!options.Preview) Get<TextBlock>("Footnote").Text = "作品与个人设置已保留";
      SetAction("进入绘遇"); main.IsEnabled = true;
      directory.IsReadOnly = true; browse.IsEnabled = false; shortcut.IsEnabled = false;
    }
    private void Reset(string error) {
      busy = false; installing = false;
      timer.Stop(); elapsed.Stop();
      Get<StackPanel>("ConfigurationPanel").Visibility = Visibility.Visible;
      Get<TextBlock>("ExistingText").Visibility = Visibility.Visible;
      Get<StackPanel>("StagePanel").Visibility = Visibility.Collapsed;
      Get<Button>("CancelButton").Visibility = Visibility.Collapsed;
      sweep.BeginAnimation(TranslateTransform.XProperty, null); sweepBar.Visibility = Visibility.Collapsed; progressHost.Visibility = Visibility.Collapsed;
      Get<TextBlock>("StepText").Text = "02  安装 / 需要处理";
      Get<TextBlock>("HeroTitle").Text = "再试一次，即可继续";
      Get<TextBlock>("HeroSubtitle").Text = "处理下方提示后继续，安装位置与个人内容会保留。";
      status.Text = "安装尚未完成"; SetAction("重新尝试");
      main.IsEnabled = true; browse.IsEnabled = !PayloadInfo.UpgradeOnly; directory.IsReadOnly = PayloadInfo.UpgradeOnly; shortcut.IsEnabled = true;
      ShowMessage(error, true);
    }
    private void Launch() {
      if (options.Preview) { View.Close(); return; }
      try { Process.Start(new ProcessStartInfo(Path.Combine(options.Directory, "ai-cg-studio-desktop.exe")) { UseShellExecute = true }); View.Close(); }
      catch { ShowMessage("应用已安装，但暂未能打开。请从桌面或开始菜单启动。", true); }
    }
    private void Closing(object sender, CancelEventArgs e) {
      if (!busy) return;
      e.Cancel = true;
      if (!installing && cancellation != null) { closeRequested = true; cancellation.Cancel(); status.Text = "正在取消准备…"; }
      else ShowMessage("安装正在进行。可以最小化窗口，完成后再关闭。", false);
    }
    public void SetPreview(string state) {
      if (!options.Preview) throw new InvalidOperationException("Preview state is not allowed for a live installation");
      if (state == "installing") {
        Progress(new InstallProgress("install", 0)); sweep.BeginAnimation(TranslateTransform.XProperty, null); sweep.X = 220;
        main.IsEnabled = false; browse.IsEnabled = false; directory.IsReadOnly = true; shortcut.IsEnabled = false; SetAction("正在安装…");
      } else if (state == "done") { progressHost.Visibility = Visibility.Visible; SetComplete(); }
      else if (state == "error") Reset("磁盘空间不足。请选择其他位置，或释放一些空间后重试。");
    }
    public void Capture(string path, int dpi) {
      SetPreview(options.State);
      FrameworkElement content = (FrameworkElement)View.Content;
      var size = new Size(View.Width, View.Height); content.Measure(size); content.Arrange(new Rect(size)); content.UpdateLayout();
      var image = new RenderTargetBitmap((int)(size.Width * dpi / 96), (int)(size.Height * dpi / 96), dpi, dpi, PixelFormats.Pbgra32);
      image.Render(content);
      Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path)));
      var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(image));
      using (Stream stream = File.Create(path)) encoder.Save(stream);
    }
    private void SetAction(string text) { action.Text = text; AutomationProperties.SetName(main, text); }
  }
}
