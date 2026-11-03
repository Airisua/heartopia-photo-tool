# Build/acceptance helpers only. The installed application does not use PowerShell.
function Initialize-LocalDpapi {
    if ('System.Security.Cryptography.ProtectedData' -as [type]) {
        return
    }
    foreach ($assembly in @('System.Security.Cryptography.ProtectedData', 'System.Security')) {
        try {
            Add-Type -AssemblyName $assembly -ErrorAction Stop
        } catch {
            # Assembly names differ between Windows PowerShell and PowerShell 7.
            # Do not echo loader errors or local runtime paths.
        }
        if ('System.Security.Cryptography.ProtectedData' -as [type]) {
            return
        }
    }
    throw 'Local Windows DPAPI support is unavailable.'
}
