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

    public InstallerWindow(InstallOptions settings) {
      options = settings; installed = InstallEngine.Existing();
      using (Stream xaml = Assembly.GetExecutingAssembly().GetManifestResourceStream("Installer.xaml")) View = (Window)XamlReader.Load(xaml);
      main = Get<Button>("MainButton"); browse = Get<Button>("BrowseButton"); directory = Get<TextBox>("PathBox");
      shortcut = Get<CheckBox>("ShortcutCheck"); status = Get<TextBlock>("StatusText"); message = Get<TextBlock>("MessageText");
      space = Get<TextBlock>("SpaceText"); action = Get<TextBlock>("MainAction"); progressHost = Get<Grid>("ProgressHost");
      scale = Get<ScaleTransform>("ProgressScale"); sweep = Get<TranslateTransform>("ProgressTranslate");
      sweepBar = Get<System.Windows.Shapes.Rectangle>("ProgressSweep");
      using (Stream art = Assembly.GetExecutingAssembly().GetManifestResourceStream("Keyart.png")) {
        var image = new BitmapImage(); image.BeginInit(); image.CacheOption = BitmapCacheOption.OnLoad; image.StreamSource = art; image.EndInit(); image.Freeze(); Get<Image>("HeroImage").Source = image;
      }
      directory.Text = String.IsNullOrEmpty(options.Directory) ? installed.Directory : options.Directory;
      shortcut.IsChecked = options.Shortcut;
      if (options.Update) shortcut.Visibility = Visibility.Collapsed;
      Get<TextBlock>("VersionText").Text = "V" + PayloadInfo.Version + "  ·  WINDOWS x64";
      Get<TextBlock>("ExistingText").Text = String.IsNullOrEmpty(installed.Version) ? "" : "已安装 " + installed.Version;
      SetAction(String.IsNullOrEmpty(installed.Version) ? "安装绘遇" : installed.Version == PayloadInfo.Version ? "重新安装" : "更新绘遇");
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
      View.Closing += Closing;
      View.Loaded += async delegate {
        if (options.Passive && !options.Preview) await BeginInstall();
        else if (options.Preview) SetPreview(options.State);
      };
      View.MinWidth = Math.Min(720, SystemParameters.WorkArea.Width - 24);
      View.MinHeight = Math.Min(460, SystemParameters.WorkArea.Height - 24);
      View.Width = Math.Min(1040, SystemParameters.WorkArea.Width - 24);
      View.Height = Math.Min(650, SystemParameters.WorkArea.Height - 24);
    }
    private T Get<T>(string name) where T : class { return (T)View.FindName(name); }
    private static Brush Color(string hex) { var brush = (SolidColorBrush)new BrushConverter().ConvertFromString(hex); brush.Freeze(); return brush; }
    private void ApplyTheme(bool value) {
      light = value;
      string[] names = { "Surface", "Card", "Line", "Text", "Muted", "Disabled", "DisabledText", "Error", "Success" };
      string[] colors = value
        ? new [] { "#FFF8F4", "#FFFFFF", "#B7BEC7", "#211C30", "#536173", "#E5E7EA", "#526173", "#A32642", "#236A50" }
        : new [] { "#211C30", "#272135", "#334354", "#FFF8F4", "#ADB9C9", "#27374A", "#B0BECE", "#FFBBC9", "#A8D8C6" };
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
      progressHost.Visibility = Visibility.Visible;
      if (value.Stage == "prepare") {
        Get<TextBlock>("StepText").Text = "02  安装 / 正在准备资源";
        status.Text = "正在准备安装资源  " + Math.Round(value.Fraction * 100) + "%";
        scale.ScaleX = value.Fraction;
      } else {
        Get<TextBlock>("StepText").Text = "02  安装 / 正在写入应用";
        installing = true; status.Text = "正在安装应用，请稍候"; space.Text = "正在写入应用与运行环境，个人创作记录将被保留。";
        scale.ScaleX = 0; sweepBar.Visibility = Visibility.Visible;
        if (SystemParameters.ClientAreaAnimation) sweep.BeginAnimation(TranslateTransform.XProperty, new DoubleAnimation(-220, 1100, TimeSpan.FromSeconds(1.8)) { RepeatBehavior = RepeatBehavior.Forever });
        else { sweepBar.Visibility = Visibility.Collapsed; scale.ScaleX = 1; }
      }
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
      cancellation = new CancellationTokenSource();
      try {
        int code = await InstallEngine.Run(options, new System.Progress<InstallProgress>(Progress), cancellation.Token);
        if (code != 0) throw new IOException("安装未完成（代码 " + code + "）。请重试，或检查安装位置。");
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
      sweep.BeginAnimation(TranslateTransform.XProperty, null); sweepBar.Visibility = Visibility.Collapsed; scale.ScaleX = 1;
      Get<TextBlock>("ExistingText").Text = "已安装 " + PayloadInfo.Version;
      Get<TextBlock>("StepText").Text = "03  完成 / 已安装绘遇";
      status.Text = "安装完成"; status.SetResourceReference(TextBlock.ForegroundProperty, "Success");
      Get<TextBlock>("HeroTitle").Text = "绘遇已就绪";
      Get<TextBlock>("HeroSubtitle").Text = "可以打开绘遇，开始创作。个人内容已保留。";
      space.Text = "已安装至 " + directory.Text;
      SetAction("进入绘遇"); main.IsEnabled = true;
      directory.IsReadOnly = true; browse.IsEnabled = false; shortcut.IsEnabled = false;
    }
    private void Reset(string error) {
      busy = false; installing = false;
      sweep.BeginAnimation(TranslateTransform.XProperty, null); sweepBar.Visibility = Visibility.Collapsed; progressHost.Visibility = Visibility.Collapsed;
      Get<TextBlock>("StepText").Text = "02  安装 / 需要处理";
      status.Text = "安装尚未完成"; SetAction("重新尝试");
      main.IsEnabled = true; browse.IsEnabled = true; directory.IsReadOnly = false; shortcut.IsEnabled = true;
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
      var size = new Size(1040, 650); content.Measure(size); content.Arrange(new Rect(size)); content.UpdateLayout();
      var image = new RenderTargetBitmap((int)(size.Width * dpi / 96), (int)(size.Height * dpi / 96), dpi, dpi, PixelFormats.Pbgra32);
      image.Render(content);
      Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path)));
      var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(image));
      using (Stream stream = File.Create(path)) encoder.Save(stream);
    }
    public void ValidateView() {
      foreach (bool theme in new [] { false, true }) {
        ApplyTheme(theme);
        foreach (string[] pair in new [] { new [] { "Text", "Surface" }, new [] { "Muted", "Surface" }, new [] { "Text", "Card" }, new [] { "Error", "Surface" }, new [] { "Success", "Surface" }, new [] { "DisabledText", "Disabled" }, new [] { "AccentText", "Accent" } }) {
          double a = Luminance(((SolidColorBrush)View.Resources[pair[0]]).Color), b = Luminance(((SolidColorBrush)View.Resources[pair[1]]).Color);
          double ratio = (Math.Max(a, b) + .05) / (Math.Min(a, b) + .05);
          if (ratio < 4.5) throw new Exception("Installer text contrast failed: " + pair[0]);
        }
        double progressA = Luminance(((SolidColorBrush)View.Resources["ProgressColor"]).Color), progressB = Luminance(((SolidColorBrush)View.Resources["Card"]).Color);
        if ((Math.Max(progressA, progressB) + .05) / (Math.Min(progressA, progressB) + .05) < 3) throw new Exception("Progress indicator contrast failed");
        FrameworkElement content = (FrameworkElement)View.Content;
        content.Measure(new Size(1040, 650)); content.Arrange(new Rect(0, 0, 1040, 650)); content.UpdateLayout();
        if (main.ActualWidth < 200 || main.ActualHeight < 44 || directory.ActualWidth < 300) throw new Exception("Installer control layout is clipped");
      }
      SetPreview("installing");
      var foreground = (SolidColorBrush)action.Foreground;
      if (foreground.Color != ((SolidColorBrush)View.Resources["DisabledText"]).Color) throw new Exception("Disabled install label must use the accessible disabled token");
    }
    private void SetAction(string text) { action.Text = text; AutomationProperties.SetName(main, text); }
    private static double Luminance(System.Windows.Media.Color color) {
      Func<byte, double> channel = value => { double v = value / 255d; return v <= .04045 ? v / 12.92 : Math.Pow((v + .055) / 1.055, 2.4); };
      return .2126 * channel(color.R) + .7152 * channel(color.G) + .0722 * channel(color.B);
    }
  }
}
