param([Parameter(Mandatory=$true)][string]$Source, [Parameter(Mandatory=$true)][string]$Archive)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$sourcePath = [IO.Path]::GetFullPath($Source)
$archivePath = [IO.Path]::GetFullPath($Archive)
if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) { throw 'Source is not a directory.' }
if (Test-Path -LiteralPath $archivePath) { throw 'Archive already exists.' }
# Framework ZipFile.CreateFromDirectory writes backslashes on some Windows builds.
# Write explicit POSIX names so the importer never has to normalize unsafe paths.
$zip = [IO.Compression.ZipFile]::Open($archivePath, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in Get-ChildItem -LiteralPath $sourcePath -Recurse -File | Sort-Object FullName) {
    if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked source files are not supported.' }
    $relative = $file.FullName.Substring($sourcePath.TrimEnd('\').Length + 1).Replace('\', '/')
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $relative, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $zip.Dispose() }
