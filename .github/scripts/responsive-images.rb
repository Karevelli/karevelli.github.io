# Adds smaller WebP versions of the project images to a built site and points the <img> tags
# of its pages at them. Runs on the output of Jekyll; a build without it keeps the originals.
# Needs libvips (vipsheader and vipsthumbnail).
#
# Usage: ruby responsive-images.rb <site folder>

require "cgi"
require "etc"
require "open3"
require "uri"

module ResponsiveImages
    WIDTHS = [480, 960, 1600].freeze
    RESIZED_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"].freeze
    MEASURED_EXTENSIONS = (RESIZED_EXTENSIONS + [".gif"]).freeze
    WEBP_OPTIONS = "[Q=80]"
    # Content images fill the container (1080px, 24px padding on each side); covers are cards
    # of a grid whose columns are at least 240px wide.
    CONTENT_SIZES = "(min-width: 1080px) 1032px, calc(100vw - 48px)"
    CARD_SIZES = "(min-width: 1080px) 240px, (min-width: 576px) 50vw, calc(100vw - 48px)"
    REPLACED_ATTRIBUTES = ["srcset", "sizes", "width", "height", "loading", "decoding", "fetchpriority"].freeze
    IMG_TAG = /<img\b[^>]*>/
    ATTRIBUTE = /([\w-]+)(?:="([^"]*)")?/

    module_function

    def run(site)
        projects = File.join(site, "projects")
        files = Dir.glob(File.join(projects, "**", "*")).sort
        # Images of a model folder are its textures: the viewer needs them untouched.
        models = files.select { |path| File.extname(path).downcase == ".fbx" }.map { |path| File.dirname(path) + "/" }.uniq
        resized = files.select do |path|
            RESIZED_EXTENSIONS.include?(File.extname(path).downcase) && models.none? { |model| path.start_with?(model) }
        end
        images = resize_all(resized)
        Dir.glob(File.join(site, "**", "*.html")).each do |page|
            html = File.read(page, encoding: "utf-8")
            marked = mark(html, site, images)
            File.write(page, marked) unless marked == html
        end
        puts "#{images.size} images, #{images.values.sum { |image| image[:widths].size }} versions"
    end

    # One libvips process per processor at a time; the result keeps the order of paths.
    def resize_all(paths)
        queue = Queue.new
        paths.each { |path| queue.push(path) }
        queue.close
        results = {}
        lock = Mutex.new
        workers = Array.new([Etc.nprocessors, paths.size].min) do
            Thread.new do
                while (path = queue.pop)
                    image = resize(path)
                    lock.synchronize { results[path] = image }
                end
            end
        end
        workers.each(&:join)
        paths.to_h { |path| [path, results.fetch(path)] }
    end

    def resize(path)
        image = measure(path)
        image[:widths] = WIDTHS.select { |width| width < image[:width] }
        image[:widths].each do |width|
            tool("vipsthumbnail", path, "--size", "#{width}x", "-o", versioned(path, width) + WEBP_OPTIONS)
        end
        image
    end

    def measure(path)
        width = tool("vipsheader", "-f", "width", path).to_i
        height = tool("vipsheader", "-f", "height", path).to_i
        { width: width, height: height, widths: [] }
    end

    def mark(html, site, images)
        first = true
        html.gsub(IMG_TAG) do |tag|
            attributes = tag.delete_prefix("<img").delete_suffix(">").delete_suffix("/").scan(ATTRIBUTE).to_h
            src = attributes["src"]
            next tag unless src&.start_with?("/projects/")
            path = File.join(site, URI::DEFAULT_PARSER.unescape(CGI.unescapeHTML(src)))
            if !images.key?(path) && File.file?(path) && MEASURED_EXTENSIONS.include?(File.extname(path).downcase)
                images[path] = measure(path)
            end
            image = images[path]
            REPLACED_ATTRIBUTES.each { |name| attributes.delete(name) }
            if image
                if image[:widths].any?
                    candidates = image[:widths].map { |width| "#{versioned(src, width)} #{width}w" }
                    candidates.push("#{src} #{image[:width]}w")
                    attributes["srcset"] = candidates.join(", ")
                    attributes["sizes"] = attributes["class"].to_s.split.include?("card-cover") ? CARD_SIZES : CONTENT_SIZES
                end
                attributes["width"] = image[:width].to_s
                attributes["height"] = image[:height].to_s
            end
            # The first image is the one most likely to be on screen when the page opens.
            if first
                attributes["fetchpriority"] = "high"
                first = false
            else
                attributes["loading"] = "lazy"
                attributes["decoding"] = "async"
            end
            "<img " + attributes.map { |name, value| value.nil? ? name : "#{name}=\"#{value}\"" }.join(" ") + ">"
        end
    end

    def versioned(path, width)
        path.sub(/\.[^.\/]+\z/, "-#{width}.webp")
    end

    def tool(*command)
        output, errors, status = Open3.capture3(*command)
        raise "#{command.join(' ')} failed:\n#{errors}" unless status.success?
        output
    end
end

ResponsiveImages.run(File.expand_path(ARGV.fetch(0)))
