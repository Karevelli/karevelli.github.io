# Checks that every local link of a built site (href, src, srcset) answers 200 when served
# like GitHub Pages does: a folder without index.html is a 404 there, while many local
# servers list it. Serves the folder on a free local port and requests each target.
#
# Usage: ruby check-links.rb <site folder>

require "cgi"
require "net/http"
require "uri"
require "webrick"

module CheckLinks
    ATTRIBUTE = /\b(href|src|srcset)="([^"]*)"/i
    SCHEME = /\A[a-z][a-z0-9+.-]*:/i
    MAX_REDIRECTS = 5

    module_function

    def run(site)
        server = WEBrick::HTTPServer.new(
            BindAddress: "127.0.0.1", Port: 0, DocumentRoot: site,
            Logger: WEBrick::Log.new(File::NULL), AccessLog: [],
            DocumentRootOptions: { FancyIndexing: false }
        )
        Thread.new { server.start }
        port = server.config[:Port]
        targets = collect(site)
        broken = targets.map { |target, pages| [status(port, target), target, pages] }.reject { |code, _, _| code == "200" }
        broken.each { |code, target, pages| puts "#{code} #{target} <- #{pages.join(", ")}" }
        puts "#{targets.size} links checked, #{broken.size} broken."
        server.shutdown
        broken.empty? ? 0 : 1
    end

    def collect(site)
        targets = Hash.new { |hash, key| hash[key] = [] }
        Dir.glob(File.join(site, "**", "*.html")).sort.each do |file|
            page = "/" + file.delete_prefix(site).tr("\\", "/").delete_prefix("/")
            File.read(file, encoding: "utf-8").scan(ATTRIBUTE) do |name, value|
                candidates = name.downcase == "srcset" ? value.split(",").map { |c| c.strip.split(/\s+/).first } : [value]
                candidates.compact.each do |raw|
                    url = CGI.unescapeHTML(raw)
                    next if url.empty? || url.start_with?("#", "//") || url.match?(SCHEME)
                    path = URI.join("http://site#{page}", url).path
                    targets[path] << page unless targets[path].include?(page)
                end
            end
        end
        targets
    end

    def status(port, path)
        MAX_REDIRECTS.times do
            response = Net::HTTP.get_response(URI("http://127.0.0.1:#{port}#{path}"))
            return response.code unless response.is_a?(Net::HTTPRedirection)
            path = URI.join("http://127.0.0.1:#{port}#{path}", response["location"]).request_uri
        end
        "redirect-loop"
    end
end

if ARGV.empty?
    warn "Usage: ruby check-links.rb <site folder>"
    exit 2
end
exit CheckLinks.run(File.expand_path(ARGV[0]))
