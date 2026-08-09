<#
Test-only Win32 P/Invoke helper: spawns a process under
CREATE_NEW_PROCESS_GROUP (System.Diagnostics.Process exposes no managed way
to set this creation flag) and sends it a targeted CTRL_BREAK_EVENT -
CTRL_C_EVENT cannot be targeted at an arbitrary process group on Windows,
only at the caller's own group (ID 0). See
docs/superpowers/specs/2026-08-09-phase-17-3-one-command-launcher-design.md,
decision 4.
#>

$hallConsoleSignalSource = @'
using System;
using System.Runtime.InteropServices;

public static class HallConsoleSignal
{
    private const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
    private const uint CTRL_BREAK_EVENT = 1;

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFO
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize;
        public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
        public int dwFlags; public short wShowWindow; public short cbReserved2;
        public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(
        string lpApplicationName, string lpCommandLine,
        IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
        bool bInheritHandles, uint dwCreationFlags,
        IntPtr lpEnvironment, string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);

    public static int StartInNewProcessGroup(string exePath, string arguments, string workingDirectory)
    {
        var startupInfo = new STARTUPINFO();
        startupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION processInfo;
        string commandLine = "\"" + exePath + "\" " + arguments;
        bool ok = CreateProcess(null, commandLine, IntPtr.Zero, IntPtr.Zero, false,
            CREATE_NEW_PROCESS_GROUP, IntPtr.Zero, workingDirectory, ref startupInfo, out processInfo);
        if (!ok)
        {
            throw new InvalidOperationException("CreateProcess failed, Win32 error " + Marshal.GetLastWin32Error());
        }
        return processInfo.dwProcessId;
    }

    public static void SendCtrlBreak(int processGroupId)
    {
        if (!GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, (uint)processGroupId))
        {
            throw new InvalidOperationException("GenerateConsoleCtrlEvent failed, Win32 error " + Marshal.GetLastWin32Error());
        }
    }
}
'@

if (-not ("HallConsoleSignal" -as [type])) {
    Add-Type -TypeDefinition $hallConsoleSignalSource
}

function Start-HallTestProcessGroup {
    param(
        [Parameter(Mandatory)][string]$ExePath,
        [Parameter(Mandatory)][string]$Arguments,
        [Parameter(Mandatory)][string]$WorkingDirectory
    )
    [HallConsoleSignal]::StartInNewProcessGroup($ExePath, $Arguments, $WorkingDirectory)
}

function Send-HallTestCtrlBreak {
    param([Parameter(Mandatory)][int]$ProcessGroupId)
    [HallConsoleSignal]::SendCtrlBreak($ProcessGroupId)
}
