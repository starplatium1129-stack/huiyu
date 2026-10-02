param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms

function New-OfflineWindow {
  [xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
 Title="绘遇 · 离线资源安装助手" Width="780" Height="710" MinWidth="600" MinHeight="510" WindowStartupLocation="CenterScreen" FontFamily="Microsoft YaHei UI" FontSize="14">
 <Window.Resources>
  <SolidColorBrush x:Key="Surface" Color="#171C26"/><SolidColorBrush x:Key="Panel" Color="#252C39"/>
  <SolidColorBrush x:Key="Text" Color="#F4F6FA"/><SolidColorBrush x:Key="Muted" Color="#B6C3D8"/>
  <SolidColorBrush x:Key="Line" Color="#6F8099"/><SolidColorBrush x:Key="Disabled" Color="#A3AEC0"/>
  <SolidColorBrush x:Key="Accent" Color="#A9CEFF"/>
  <Style TargetType="TextBlock"><Setter Property="Foreground" Value="{DynamicResource Text}"/><Setter Property="TextWrapping" Value="Wrap"/></Style>
  <Style TargetType="Control"><Setter Property="Foreground" Value="{DynamicResource Text}"/><Setter Property="Background" Value="{DynamicResource Panel}"/></Style>
  <Style TargetType="Button" BasedOn="{StaticResource {x:Type Control}}">
   <Setter Property="Padding" Value="16,9"/><Setter Property="MinHeight" Value="40"/><Setter Property="Margin" Value="6,0,0,0"/>
   <Setter Property="Template"><Setter.Value><ControlTemplate TargetType="Button">
    <Border x:Name="Frame" Background="{TemplateBinding Background}" BorderBrush="{DynamicResource Line}" BorderThickness="1" CornerRadius="6" Padding="{TemplateBinding Padding}">
     <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
    </Border><ControlTemplate.Triggers>
     <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="Frame" Property="BorderBrush" Value="{DynamicResource Accent}"/></Trigger>
     <Trigger Property="IsKeyboardFocused" Value="True"><Setter TargetName="Frame" Property="BorderThickness" Value="2"/></Trigger>
     <Trigger Property="IsEnabled" Value="False"><Setter Property="Foreground" Value="{DynamicResource Disabled}"/></Trigger>
    </ControlTemplate.Triggers>
   </ControlTemplate></Setter.Value></Setter>
  </Style>
  <Style TargetType="TextBox" BasedOn="{StaticResource {x:Type Control}}"><Setter Property="Padding" Value="8"/><Setter Property="BorderBrush" Value="{DynamicResource Line}"/><Setter Property="CaretBrush" Value="{DynamicResource Text}"/></Style>
  <Style TargetType="CheckBox" BasedOn="{StaticResource {x:Type Control}}"><Setter Property="Foreground" Value="{DynamicResource Text}"/></Style>
 </Window.Resources>
 <Grid Background="{DynamicResource Surface}" Margin="0">
  <Grid Margin="24"><Grid.RowDefinitions><RowDefinition Height="*"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
   <ScrollViewer VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled">
    <StackPanel>
     <TextBlock Text="安装离线资源" FontSize="26" FontWeight="SemiBold"/>
     <TextBlock Text="选择已下载的 ZIP，自动校验后再安装。全程无需输入命令或哈希。" Foreground="{DynamicResource Muted}" Margin="0,8,0,20"/>
     <TextBlock Text="资源 ZIP" Margin="0,0,0,6"/>
     <DockPanel><Button x:Name="Choose" Content="选择 ZIP…" DockPanel.Dock="Right"/><TextBox x:Name="Archive" IsReadOnly="True" VerticalContentAlignment="Center" AutomationProperties.Name="已选择的资源 ZIP"/></DockPanel>
     <Expander Header="安装位置与高级选项" Foreground="{DynamicResource Text}" Margin="0,14,0,12">
      <StackPanel Margin="0,12,0,0">
       <TextBlock Text="程序安装目录（留空时自动查找）"/><DockPanel Margin="0,6,0,10"><Button x:Name="BrowseInstall" Content="浏览…" DockPanel.Dock="Right"/><TextBox x:Name="InstallDir" AutomationProperties.Name="程序安装目录"/></DockPanel>
       <TextBlock Text="运行目录（通常无需更改；独立配置请选择对应 gateway 目录）"/><DockPanel Margin="0,6,0,0"><Button x:Name="BrowseRuntime" Content="浏览…" DockPanel.Dock="Right"/><TextBox x:Name="RuntimeRoot" AutomationProperties.Name="用户运行目录"/></DockPanel>
      </StackPanel>
     </Expander>
     <TextBlock x:Name="Status" Text="等待选择 ZIP" FontWeight="SemiBold" FontSize="17" Margin="0,6,0,8" AutomationProperties.LiveSetting="Polite"/>
     <ProgressBar x:Name="Progress" Height="8" Minimum="0" Maximum="100" Foreground="{DynamicResource Accent}" Background="{DynamicResource Panel}" AutomationProperties.Name="当前阶段进度"/>
     <TextBox x:Name="Details" IsReadOnly="True" TextWrapping="Wrap" VerticalScrollBarVisibility="Auto" Height="205" Margin="0,14,0,14" AutomationProperties.Name="校验结果和恢复说明"/>
     <TextBlock Text="助手必须来自绘遇官方独立发布来源。只接受内置清单批准的资源包；模型与运行环境需另行准备。" Foreground="{DynamicResource Muted}"/>
     <CheckBox x:Name="Closed" Margin="0,16,0,14"><TextBlock Text="我已保存工作，并从托盘菜单完全退出绘遇"/></CheckBox>
    </StackPanel>
   </ScrollViewer>
   <DockPanel Grid.Row="1" Margin="0,18,0,0" LastChildFill="False">
    <Button x:Name="Install" Content="确认安装" DockPanel.Dock="Right" IsEnabled="False"/>
    <Button x:Name="Cancel" Content="取消任务" DockPanel.Dock="Right" IsEnabled="False"/>
    <Button x:Name="Verify" Content="重新校验" DockPanel.Dock="Right" IsEnabled="False"/>
    <Button x:Name="Theme" Content="深 / 浅" DockPanel.Dock="Left" Margin="0"/>
   </DockPanel>
  </Grid>
 </Grid>
</Window>
"@
  $window = [Windows.Markup.XamlReader]::Load((New-Object Xml.XmlNodeReader $xaml))
  $window.Background = $window.Resources['Surface']
  return $window
}
function Set-OfflineTheme($Window, [bool]$Light) {
  $colors = if ($Light) {
    @{ Surface='#F5F7FB'; Panel='#FFFFFF'; Text='#192335'; Muted='#455570'; Line='#667994'; Disabled='#53627A'; Accent='#245FAB' }
  } else {
    @{ Surface='#171C26'; Panel='#252C39'; Text='#F4F6FA'; Muted='#B6C3D8'; Line='#6F8099'; Disabled='#A3AEC0'; Accent='#A9CEFF' }
  }
  foreach ($key in $colors.Keys) { $Window.Resources[$key] = [Windows.Media.BrushConverter]::new().ConvertFromString($colors[$key]) }
  $Window.Background = $Window.Resources['Surface']
}
function Get-OfflineError([string]$Message) {
  $hint = switch -Regex ($Message) {
    'UNTRUSTED_RELEASE|approval|identity mismatch' { '资源包未获当前助手批准。请从官方来源取得匹配的助手和 ZIP；不要使用包内哈希代替审批。'; break }
    'LOCK|BUSY|lease|占用|锁' { '运行目录正在使用中。请保存工作，从托盘完全退出绘遇，等待退出完成后点击「重试安装」。'; break }
    'USAGE|Unknown.*argument' { '当前程序版本尚不支持图形助手的安全取消功能。请安装配套新版绘遇，再重试。'; break }
    'CANCELLED|cancelled|取消|TIMEOUT' { '任务已取消或超时。未确认安装完成；保留的暂存目录可用于恢复。'; break }
    'space|disk|空间' { '可用磁盘空间不足。请为临时解压目录与资源库准备空间后重试。'; break }
    'Missing path|Multiple installations' { '未找到唯一可用的绘遇安装。请在「安装位置与高级选项」选择程序目录后重新校验。'; break }
    'hash mismatch|ZIP|inventory|Metadata|Unsafe|Linked' { '资源包损坏、内容不一致或路径不安全。请从官方来源重新取得完整 ZIP 后再校验。'; break }
    default { '导入未确认完成。请查看下方诊断，保留暂存目录，排除问题后使用同一 ZIP 重试。' }
  }
  return "$hint`r`n`r`n诊断：$Message"
}
# Dot-sourcing exposes the actual view and theme functions for isolated visual QA.
if ($MyInvocation.InvocationName -eq '.') { return }
$window = New-OfflineWindow
$controls = @{}
foreach ($name in 'Choose','Archive','InstallDir','RuntimeRoot','BrowseInstall','BrowseRuntime','Status','Progress','Details','Closed','Install','Cancel','Verify','Theme') { $controls[$name] = $window.FindName($name) }
$ui = @{ Busy=$false; Ready=$false; Job=$null; Staging=$null; Light=$false; Preview=$null; Applying=$false }
$ui.Light = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -ErrorAction SilentlyContinue).AppsUseLightTheme -eq 1
Set-OfflineTheme $window $ui.Light
$controls.RuntimeRoot.Text = Join-Path $env:APPDATA 'com.aics.studio\gateway'
$controls.Details.Text = '自动核验独立审批指纹、完整文件集合及每项 SHA-256。校验不会写入资源库。安装后保留原有版本与用户修改的样张。'
$worker = Join-Path $PSScriptRoot 'install-offline-resources.ps1'
function Update-OfflineActions {
  foreach ($name in 'Choose','BrowseInstall','BrowseRuntime') { $controls[$name].IsEnabled = -not $ui.Busy }
  foreach ($name in 'InstallDir','RuntimeRoot') { $controls[$name].IsReadOnly = $ui.Busy }
  $controls.Verify.IsEnabled = -not $ui.Busy -and [bool]$controls.Archive.Text
  $controls.Install.IsEnabled = -not $ui.Busy -and $ui.Ready -and $controls.Closed.IsChecked
  $controls.Cancel.IsEnabled = $ui.Busy -and -not $ui.Job.State.Cancel
}
function Start-OfflineJob([bool]$Apply) {
  if ($ui.Busy) { return }
  $state = [hashtable]::Synchronized(@{ Cancel=$false; Phase='inventory'; Done=0; Total=0; Finished=$false; Error=$null; Result=$null; Staging=$null; CanResume=$false })
  $options = @{ Archive=$controls.Archive.Text; InstallDir=$controls.InstallDir.Text.Trim(); RuntimeRoot=$controls.RuntimeRoot.Text.Trim();
    TrustedRelease=$true; Verify=$true; ProgressState=$state; Apply=$Apply }
  if ($Apply -and $ui.Staging) { $options.ResumeStaging = $ui.Staging }
  $shell = [PowerShell]::Create()
  $shell.AddScript({ param($worker, $options, $state)
    try { $state.Result = (& $worker @options) | ConvertFrom-Json }
    catch { $state.Error = $_.Exception.Message }
    finally { $state.Finished = $true }
  }).AddArgument($worker).AddArgument($options).AddArgument($state) | Out-Null
  $ui.Busy = $true; $ui.Applying = $Apply
  if (-not $Apply) { $ui.Ready = $false }
  $ui.Job = @{ Shell=$shell; Handle=$shell.BeginInvoke(); State=$state }
  $controls.Details.Text = if ($Apply) { '正在准备安装。正在运行的绘遇会被原生目录锁拒绝；助手不会强制关闭应用。' } else { '正在逐项读取并核对资源字节。大包需要一些时间，可以取消。' }
  Update-OfflineActions
}
$controls.Choose.Add_Click({
  $picker = New-Object Microsoft.Win32.OpenFileDialog
  $picker.Filter = '离线资源 ZIP (*.zip)|*.zip'
  if ($picker.ShowDialog($window)) {
    $controls.Archive.Text = $picker.FileName; $ui.Staging = $null; $ui.Preview = $null
    $controls.Install.Content = '确认安装'
    Start-OfflineJob $false
  }
})
$controls.Verify.Add_Click({ Start-OfflineJob $false })
$controls.Install.Add_Click({
  if (-not $ui.Ready -or $ui.Busy -or -not $controls.Closed.IsChecked) { return }
  $message = "安装 $($ui.Preview.releaseId)？`r`n`r`n运行目录：$($ui.Preview.runtimeRoot)`r`n原有版本和用户修改的样张会保留。请确保已从托盘完全退出绘遇。"
  if ([Windows.MessageBox]::Show($window, $message, '确认安装离线资源', 'OKCancel', 'Question') -eq 'OK') { Start-OfflineJob $true }
})
$controls.Cancel.Add_Click({ if ($ui.Job) { $ui.Job.State.Cancel = $true; $controls.Status.Text = '正在安全取消，请稍候…'; Update-OfflineActions } })
$controls.Closed.Add_Click({ Update-OfflineActions })
$controls.Theme.Add_Click({ $ui.Light = -not $ui.Light; Set-OfflineTheme $window $ui.Light })
foreach ($name in 'InstallDir','RuntimeRoot') {
  $controls[$name].Add_TextChanged({ if (-not $ui.Busy) { $ui.Ready = $false; $ui.Staging = $null; Update-OfflineActions } })
}
$controls.BrowseInstall.Add_Click({
  $picker = New-Object Windows.Forms.FolderBrowserDialog
  $picker.Description = '选择包含 gateway 文件夹的绘遇程序安装目录'
  try { if ($picker.ShowDialog() -eq 'OK') { $controls.InstallDir.Text = $picker.SelectedPath } } finally { $picker.Dispose() }
})
$controls.BrowseRuntime.Add_Click({
  $picker = New-Object Windows.Forms.FolderBrowserDialog
  $picker.Description = '选择本次使用的用户运行目录 gateway'
  try { if ($picker.ShowDialog() -eq 'OK') { $controls.RuntimeRoot.Text = $picker.SelectedPath } } finally { $picker.Dispose() }
})
$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(150)
$timer.Add_Tick({
  if (-not $ui.Job) { return }
  $state = $ui.Job.State
  $phases = @{ inventory='正在核验受信清单'; verifying='正在校验全部文件'; extracting='正在解压并再次核验'; installing='正在原生安装 · 保留用户修改'; cancelling='正在安全取消，请稍候' }
  $controls.Status.Text = $phases[$state.Phase]
  $controls.Progress.IsIndeterminate = $state.Total -eq 0
  if ($state.Total -gt 0) {
    $controls.Progress.Value = 100.0 * $state.Done / $state.Total
    $controls.Status.Text += ' · ' + [Math]::Floor($controls.Progress.Value) + '%'
  }
  if (-not $ui.Job.Handle.IsCompleted) { return }
  try { $ui.Job.Shell.EndInvoke($ui.Job.Handle) | Out-Null } catch { $state.Error = $_.Exception.Message }
  $ui.Job.Shell.Dispose(); $ui.Job = $null; $ui.Busy = $false
  $controls.Progress.IsIndeterminate = $false
  if ($state.CanResume) { $ui.Staging = $state.Staging }
  if ($state.Error) {
    $controls.Status.Text = '未完成 · 可以重试'
    $controls.Details.Text = Get-OfflineError $state.Error
    if ($state.Staging) { $controls.Details.Text += "`r`n`r`n暂存目录已保留：$($state.Staging)`r`n请勿删除。完整暂存可用「重试安装」继续；关闭助手后也可重新选择同一 ZIP 恢复。" }
    if ($ui.Applying) { $controls.Install.Content = '重试安装' }
  } elseif ($ui.Applying) {
    $ui.Staging = $null; $ui.Ready = $false
    $controls.Progress.Value = 100
    $controls.Status.Text = '安装完成 · 请重新启动绘遇'
    $controls.Details.Text = "已安装：$($state.Result.releaseId)`r`n`r`n请重新启动绘遇，断网检查角色原图、场景卡片及样张画册。模型需单独准备。"
    if ($state.Staging) { $controls.Details.Text += "`r`n`r`n安装成功，临时文件未能清理：$($state.Staging)" }
  } else {
    $ui.Preview = $state.Result; $ui.Ready = $true
    $controls.Progress.Value = 100
    $controls.Status.Text = '校验通过 · 等待确认安装'
    $controls.Details.Text = "版本：$($state.Result.releaseId)`r`n文件：$($state.Result.files) 项，解压后 $([Math]::Round($state.Result.bytes / 1GB, 2)) GiB`r`n程序：$($state.Result.installDir)`r`n运行目录：$($state.Result.runtimeRoot)`r`n`r`n批准来源：$($state.Result.trustedSource)`r`n审批指纹：$($state.Result.releaseSha256)"
  }
  Update-OfflineActions
})
$window.Add_Closing({
  param($sender, $eventArgs)
  if ($ui.Busy) {
    $eventArgs.Cancel = $true; $ui.Job.State.Cancel = $true
    $controls.Status.Text = '正在安全取消，请等待任务结束后关闭'
    Update-OfflineActions
  }
})
$window.Height = [Math]::Min($window.Height, [Windows.SystemParameters]::WorkArea.Height)
$window.Width = [Math]::Min($window.Width, [Windows.SystemParameters]::WorkArea.Width)
try { $timer.Start(); $window.ShowDialog() | Out-Null } finally { $timer.Stop() }
