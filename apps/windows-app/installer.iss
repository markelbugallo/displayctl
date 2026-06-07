[Setup]
AppName=displayctl
AppVersion=0.1.0
AppVerName=displayctl
UninstallDisplayName=displayctl
DefaultDirName={localappdata}\displayctl
DefaultGroupName=displayctl
UninstallDisplayIcon={app}\displayctl.exe
SetupIconFile=..\..\assets\displayctl.ico
Compression=lzma2
SolidCompression=yes
OutputDir=output
OutputBaseFilename=displayctl-setup
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest

[Files]
Source: "target\release\displayctl.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\displayctl"; Filename: "{app}\displayctl.exe"

[Tasks]
Name: "startup"; Description: "Iniciar displayctl al encender el PC"; GroupDescription: "Opciones adicionales:"; Flags: checkedonce

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "displayctl"; ValueData: """{app}\displayctl.exe"""; Flags: uninsdeletevalue; Tasks: startup

[Run]
Filename: "{app}\displayctl.exe"; Description: "Ejecutar displayctl ahora"; Flags: nowait postinstall skipifsilent
