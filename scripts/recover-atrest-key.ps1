param(
  [string]$ProcessName = "WorkBuddy",
  [int]$MaxCandidates = 4000,
  [long]$MaxBytes = 1800MB
)

$ErrorActionPreference = "Stop"

$src = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

public class WbKeyScan
{
    const int PROCESS_QUERY_INFORMATION = 0x0400;
    const int PROCESS_VM_READ = 0x0010;
    const uint MEM_COMMIT = 0x1000;
    const uint PAGE_NOACCESS = 0x01;
    const uint PAGE_GUARD = 0x100;

    [StructLayout(LayoutKind.Sequential)]
    struct MEMORY_BASIC_INFORMATION
    {
        public IntPtr BaseAddress;
        public IntPtr AllocationBase;
        public uint AllocationProtect;
        public IntPtr RegionSize;
        public uint State;
        public uint Protect;
        public uint Type;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(int access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr VirtualQueryEx(IntPtr process, IntPtr address, out MEMORY_BASIC_INFORMATION info, IntPtr length);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);

    static readonly Regex Candidate = new Regex("[A-Za-z0-9+/]{43}=", RegexOptions.Compiled);
    static readonly Encoding Latin1 = Encoding.GetEncoding(28591);

    public static string[] Scan(string processName, int maxCandidates, long maxBytes)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var outp = new List<string>();
        long scanned = 0;
        var procs = Process.GetProcessesByName(processName);
        Array.Sort(procs, (a, b) => SafeMb(b).CompareTo(SafeMb(a)));

        foreach (var proc in procs)
        {
            if (scanned >= maxBytes) break;
            IntPtr h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, proc.Id);
            if (h == IntPtr.Zero) continue;
            try
            {
                long addr = 0;
                long maxAddr = Is64 ? 0x7FFFFFFFFFFFL : 0x7FFFFFFF;
                MEMORY_BASIC_INFORMATION info;
                int mbiSize = Marshal.SizeOf(typeof(MEMORY_BASIC_INFORMATION));
                while (addr < maxAddr && scanned < maxBytes)
                {
                    if (VirtualQueryEx(h, (IntPtr)addr, out info, (IntPtr)mbiSize) == IntPtr.Zero) break;
                    long regionSize = (long)info.RegionSize;
                    long next = addr + Math.Max(regionSize, 0x1000);
                    if (info.State == MEM_COMMIT && (info.Protect & PAGE_NOACCESS) == 0 && (info.Protect & PAGE_GUARD) == 0 && regionSize > 0)
                    {
                        long remain = regionSize;
                        long cursor = addr;
                        while (remain > 0 && scanned < maxBytes)
                        {
                            int chunk = (int)Math.Min(remain, 16L * 1024 * 1024);
                            byte[] buf = new byte[chunk];
                            IntPtr read;
                            if (ReadProcessMemory(h, (IntPtr)cursor, buf, (IntPtr)chunk, out read) && read.ToInt64() > 0)
                            {
                                int got = (int)read.ToInt64();
                                scanned += got;
                                string text = Latin1.GetString(buf, 0, got);
                                foreach (Match m in Candidate.Matches(text))
                                {
                                    if (seen.Add(m.Value))
                                    {
                                        outp.Add(m.Value);
                                        if (outp.Count >= maxCandidates) return outp.ToArray();
                                    }
                                }
                            }
                            else
                            {
                                scanned += chunk;
                            }
                            cursor += chunk;
                            remain -= chunk;
                        }
                    }
                    addr = next;
                }
            }
            finally
            {
                CloseHandle(h);
            }
            if (outp.Count >= maxCandidates) break;
        }
        return outp.ToArray();
    }

    static bool Is64 { get { return IntPtr.Size == 8; } }
    static long SafeMb(Process p) { try { return p.WorkingSet64; } catch { return 0; } }
}
'@

Add-Type -TypeDefinition $src -Language CSharp

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$found = [WbKeyScan]::Scan($ProcessName, $MaxCandidates, $MaxBytes)
$sw.Stop()

Write-Output "SCANNED_MS=$($sw.ElapsedMilliseconds)"
Write-Output "COUNT=$($found.Count)"
$found | ForEach-Object { Write-Output $_ }
